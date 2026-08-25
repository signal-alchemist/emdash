import {
	validateContentSyncResult,
	validateMediaSourceRef,
	type ContentSyncCommand,
	type ContentSyncResult,
	type MediaSourceRef,
} from "@signal-alchemist/marketing-automation-contracts";

import { hexDigest, stableStringify, type SyncPlan, validateSyncPlan } from "./planner.js";
import {
	contentHash,
	prepareSyncReceipt,
	persistSyncReceipt,
	readSyncReceipt,
	updateSyncReceipt,
	type ReceiptCollection,
	type SyncReceipt,
} from "./receipts.js";

const MAX_COMMANDS = 512;
const MAX_WARNINGS = 128;
const MAX_WARNING_LENGTH = 200;
const APPLY_ERROR = /^GITHUB_SYNC_APPLY_[A-Z0-9_]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
// In-flight work is only a request-level optimization.  Scope it to the
// durable storage object so identical plans in two sandbox contexts never
// share a result (or a rejected promise).  WeakMap avoids retaining a context
// after its sandbox has been torn down.
const activeRunsByStorage = new WeakMap<object, Map<string, Promise<ContentSyncApplyResult>>>();

type SyncRunRecord = {
	status: "running" | "succeeded" | "conflict" | "failed";
	planDigest: string;
	completed: number[];
	results: ContentSyncResult[];
	uploadedMediaIds: string[];
	warnings: string[];
};

type SyncMapping = {
	sourceKey: string;
	repository: string;
	branch: string;
	sourcePath: string;
	locale: string;
	contentId: string;
	collection: string;
	emdashId: string;
	lastCommitSha: string;
	lastPlanDigest: string;
	revision?: string;
	route: string;
	publication: string;
	mediaIds: string[];
	attemptId: string;
	status: "active" | "quarantined";
};

type ContentItem = {
	id: string;
	data: Record<string, unknown>;
	revision?: string;
	status?: string;
};
type ContentAccessWithWrite = {
	get(collection: string, id: string): Promise<ContentItem | null>;
	list(
		collection: string,
		options?: { limit?: number; where?: { locale?: string } },
	): Promise<{ items: ContentItem[] }>;
	create(
		collection: string,
		data: Record<string, unknown>,
		options?: { locale?: string },
	): Promise<ContentItem>;
	update(
		collection: string,
		id: string,
		data: Record<string, unknown>,
		options?: { expectedRevision?: string; slug?: string | null },
	): Promise<ContentItem>;
	publish(
		collection: string,
		id: string,
		options?: { expectedRevision?: string },
	): Promise<ContentItem>;
	unpublish(
		collection: string,
		id: string,
		options?: { expectedRevision?: string },
	): Promise<ContentItem>;
};
type MediaAccessWithWrite = {
	get(id: string): Promise<{ id: string; sha256?: string | null } | null>;
	upload(
		filename: string,
		contentType: string,
		bytes: ArrayBuffer,
		options?: { sha256?: string; alt?: string; deduplicate?: boolean },
	): Promise<{ mediaId: string; storageKey: string; url: string }>;
};
type AppliedCommand = { result: ContentSyncResult; item?: ContentItem };

export type ApplyContext = {
	content?: ContentAccessWithWrite;
	media?: MediaAccessWithWrite;
	http?: { fetch(url: string, init?: RequestInit): Promise<Response> };
	storage: {
		sync_receipts?: ReceiptCollection;
		sync_runs: {
			get(id: string): Promise<{ id: string; data: unknown } | null>;
			put(id: string, data: unknown): Promise<void>;
		};
		sync_mappings: {
			get(id: string): Promise<{ id: string; data: unknown } | null>;
			put(id: string, data: unknown): Promise<void>;
			delete(id: string): Promise<boolean>;
			query(options?: { limit?: number }): Promise<{ items: Array<{ id: string; data: unknown }> }>;
		};
	};
};

export type ContentSyncApplyResult = {
	version: 1;
	planDigest: string;
	status: "succeeded" | "conflict" | "failed";
	results: ContentSyncResult[];
	uploadedMediaIds: string[];
	warnings: string[];
};

function fail(code: string): never {
	throw new Error(`GITHUB_SYNC_APPLY_${code}`);
}

function boundedWarning(value: string): string {
	return value.slice(0, MAX_WARNING_LENGTH);
}

function isConflict(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "PluginRevisionConflictError" ||
			error.message === "GITHUB_SYNC_APPLY_MAPPING_CONFLICT" ||
			error.message === "GITHUB_SYNC_APPLY_MAPPING_REQUIRED" ||
			error.message === "GITHUB_SYNC_APPLY_MAPPING_IDENTITY")
	);
}

function stableErrorCode(error: unknown): string {
	if (isConflict(error)) return "REVISION_CONFLICT";
	if (error instanceof Error && APPLY_ERROR.test(error.message))
		return error.message.slice("GITHUB_SYNC_APPLY_".length);
	return "APPLY_FAILED";
}

function mappingKey(command: ContentSyncCommand): string {
	const locale = typeof command.fields.locale === "string" ? command.fields.locale : "";
	return encodeURIComponent(
		`${command.source.repository}|${command.source.branch}|${command.source.path}|${locale}`,
	);
}

function mappingFor(
	command: ContentSyncCommand,
	item: ContentItem,
	plan: SyncPlan,
	mediaIds: string[],
	status: SyncMapping["status"] = "active",
): SyncMapping {
	return {
		sourceKey: mappingKey(command),
		repository: command.source.repository,
		branch: command.source.branch,
		sourcePath: command.source.path,
		locale: typeof command.fields.locale === "string" ? command.fields.locale : "en",
		contentId: command.contentId ?? "",
		collection: command.collection,
		emdashId: item.id,
		lastCommitSha: plan.commitSha,
		lastPlanDigest: plan.planDigest,
		revision: item.revision,
		route: typeof command.fields.canonicalRoute === "string" ? command.fields.canonicalRoute : "",
		publication: command.publishState,
		mediaIds: [...mediaIds],
		attemptId: `${plan.trace.deliveryId}:${plan.commitSha}`,
		status,
	};
}

function readMapping(value: unknown): SyncMapping | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const mapping = value as Partial<SyncMapping>;
	if (
		typeof mapping.sourceKey !== "string" ||
		typeof mapping.repository !== "string" ||
		typeof mapping.branch !== "string" ||
		typeof mapping.sourcePath !== "string" ||
		typeof mapping.locale !== "string" ||
		typeof mapping.contentId !== "string" ||
		typeof mapping.collection !== "string" ||
		typeof mapping.emdashId !== "string" ||
		typeof mapping.lastCommitSha !== "string" ||
		typeof mapping.lastPlanDigest !== "string" ||
		typeof mapping.route !== "string" ||
		typeof mapping.publication !== "string" ||
		!Array.isArray(mapping.mediaIds) ||
		!mapping.mediaIds.every((id) => typeof id === "string" && id.length <= 128) ||
		(mapping.status !== "active" && mapping.status !== "quarantined")
	)
		return null;
	return mapping as SyncMapping;
}

function mappingMatches(
	mapping: SyncMapping,
	command: ContentSyncCommand,
	allowRenamePath: boolean,
): boolean {
	return (
		mapping.repository === command.source.repository &&
		mapping.branch === command.source.branch &&
		mapping.locale === (typeof command.fields.locale === "string" ? command.fields.locale : "en") &&
		mapping.contentId === (command.contentId ?? "") &&
		mapping.collection === command.collection &&
		mapping.status === "active" &&
		(allowRenamePath || mapping.sourcePath === command.source.path)
	);
}

function readRunRecord(value: unknown): SyncRunRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Partial<SyncRunRecord>;
	if (
		(record.status !== "running" &&
			record.status !== "succeeded" &&
			record.status !== "conflict" &&
			record.status !== "failed") ||
		typeof record.planDigest !== "string" ||
		!SHA256.test(record.planDigest) ||
		!Array.isArray(record.completed) ||
		record.completed.length > MAX_COMMANDS ||
		!record.completed.every(
			(index) => Number.isSafeInteger(index) && index >= 0 && index < MAX_COMMANDS,
		) ||
		!Array.isArray(record.results) ||
		record.results.length > MAX_COMMANDS ||
		!Array.isArray(record.uploadedMediaIds) ||
		record.uploadedMediaIds.length > MAX_COMMANDS ||
		!record.uploadedMediaIds.every((id) => typeof id === "string" && id.length <= 128) ||
		!Array.isArray(record.warnings) ||
		record.warnings.length > MAX_WARNINGS ||
		!record.warnings.every(
			(warning) => typeof warning === "string" && warning.length <= MAX_WARNING_LENGTH,
		)
	)
		return null;
	try {
		return {
			status: record.status,
			planDigest: record.planDigest,
			completed: [...record.completed],
			results: record.results.map((result) => validateContentSyncResult(result)),
			uploadedMediaIds: [...record.uploadedMediaIds],
			warnings: [...record.warnings],
		};
	} catch {
		return null;
	}
}

function sourceOf(command: ContentSyncCommand): ContentSyncResult["source"] {
	return command.source;
}

function resultFor(
	command: ContentSyncCommand,
	status: ContentSyncResult["status"],
	extra: Partial<ContentSyncResult> = {},
): ContentSyncResult {
	return validateContentSyncResult({
		version: 1,
		source: sourceOf(command),
		status,
		uploadedMediaIds: [],
		warnings: [],
		completedAt: new Date().toISOString(),
		...extra,
	});
}

async function sha256(bytes: Uint8Array): Promise<string> {
	return hexDigest(bytes);
}

function readMediaManifest(plan: SyncPlan): MediaSourceRef[] {
	try {
		const parsed: unknown = JSON.parse(plan.mediaManifest);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			(parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
			!Array.isArray((parsed as { media?: unknown }).media)
		)
			fail("MEDIA_MANIFEST");
		return (parsed as { media: unknown[] }).media.map((entry) => validateMediaSourceRef(entry));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("GITHUB_SYNC_APPLY_")) throw error;
		fail("MEDIA_MANIFEST");
	}
}

async function findExisting(
	content: ContentAccessWithWrite,
	command: ContentSyncCommand,
): Promise<ContentItem | undefined> {
	if (!command.contentId) return undefined;
	const listed = await content.list(command.collection, {
		limit: 100,
		where: {
			locale: typeof command.fields.locale === "string" ? command.fields.locale : undefined,
		},
	});
	return listed.items.find((item) => item.data.contentId === command.contentId);
}

async function uploadMedia(
	plan: SyncPlan,
	media: MediaAccessWithWrite,
	http: NonNullable<ApplyContext["http"]>,
	entry: MediaSourceRef,
): Promise<string> {
	const url = `https://raw.githubusercontent.com/${plan.repository}/${plan.commitSha}/${entry.sourcePath}`;
	const response = await http.fetch(url, { method: "GET", redirect: "error" });
	if (!response.ok || response.redirected || (response.url && response.url !== url))
		fail("MEDIA_FETCH");
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (
		bytes.byteLength !== entry.bytes ||
		response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
			entry.mimeType.toLowerCase()
	)
		fail("MEDIA_METADATA");
	const digest = await sha256(bytes);
	if (digest !== entry.sha256) fail("MEDIA_SHA");
	const uploaded = await media.upload(entry.sourcePath, entry.mimeType, bytes.buffer, {
		sha256: digest,
		alt: entry.alt,
		deduplicate: true,
	});
	return uploaded.mediaId;
}

async function applyCommand(
	plan: SyncPlan,
	ctx: ApplyContext,
	command: ContentSyncCommand,
	mediaManifest: Map<string, MediaSourceRef>,
	uploaded: string[],
	mapping: SyncMapping | undefined,
): Promise<AppliedCommand> {
	if (!ctx.content) fail("CONTENT_CAPABILITY");
	const content = ctx.content;
	let existing: ContentItem | undefined;
	if (mapping) existing = (await content.get(mapping.collection, mapping.emdashId)) ?? undefined;
	if (!existing) existing = await findExisting(content, command);
	if (
		mapping &&
		command.expectedRevision !== undefined &&
		command.expectedRevision !== mapping.revision
	)
		fail("MAPPING_CONFLICT");
	if (mapping && (!existing || existing.revision !== mapping.revision)) fail("MAPPING_CONFLICT");
	if (!mapping && existing) fail("MAPPING_REQUIRED");
	const expectedRevision = mapping?.revision ?? command.expectedRevision;
	if (command.operation === "delete") fail("DELETE_FORBIDDEN");
	const mediaIds: string[] = [];
	for (const ref of command.media) {
		const entry = mediaManifest.get(ref.sourcePath);
		if (!entry || entry.sha256 !== ref.sha256) fail("MEDIA_NOT_IN_PLAN");
		if (!ctx.media || !ctx.http) fail("MEDIA_CAPABILITY");
		const id = await uploadMedia(plan, ctx.media, ctx.http, entry);
		mediaIds.push(id);
		if (!uploaded.includes(id)) uploaded.push(id);
	}
	let item: ContentItem | null = existing ?? null;
	if (command.operation === "unpublish") {
		if (!existing)
			return { result: resultFor(command, "skipped", { warnings: ["content-not-found"] }) };
		item = await content.unpublish(command.collection, existing.id, {
			expectedRevision,
		});
	} else if (existing) {
		const fields = mediaIds.length > 0 ? { ...command.fields, mediaIds } : command.fields;
		item = await content.update(command.collection, existing.id, fields, {
			expectedRevision,
			slug: command.slug,
		});
		if (command.publishState === "published")
			item = await content.publish(command.collection, existing.id, {
				expectedRevision: item.revision,
			});
	} else {
		const fields = mediaIds.length > 0 ? { ...command.fields, mediaIds } : command.fields;
		item = await content.create(command.collection, fields, {
			locale: typeof command.fields.locale === "string" ? command.fields.locale : undefined,
		});
		if (command.publishState === "published")
			item = await content.publish(command.collection, item.id, {
				expectedRevision: item.revision,
			});
	}
	return {
		result: resultFor(command, "succeeded", {
			contentId: command.contentId,
			revision: item.revision,
			uploadedMediaIds: mediaIds,
		}),
		item,
	};
}

async function findMapping(
	ctx: ApplyContext,
	command: ContentSyncCommand,
): Promise<SyncMapping | undefined> {
	const direct = readMapping((await ctx.storage.sync_mappings.get(mappingKey(command)))?.data);
	if (direct && mappingMatches(direct, command, false)) return direct;
	if (direct) fail("MAPPING_IDENTITY");
	const listed = await ctx.storage.sync_mappings.query({ limit: 512 });
	return listed.items
		.map((item) => readMapping(item.data))
		.find(
			(mapping): mapping is SyncMapping =>
				mapping !== null && mappingMatches(mapping, command, true),
		);
}

async function findMappingByPath(
	ctx: ApplyContext,
	path: string,
): Promise<SyncMapping | undefined> {
	const listed = await ctx.storage.sync_mappings.query({ limit: 512 });
	return listed.items
		.map((item) => readMapping(item.data))
		.find(
			(mapping): mapping is SyncMapping =>
				mapping !== null && mapping.sourcePath === path && mapping.status === "active",
		);
}

async function applyValidatedPlan(
	plan: SyncPlan,
	ctx: ApplyContext,
): Promise<ContentSyncApplyResult> {
	if (plan.commands.length > MAX_COMMANDS) fail("LIMIT");
	const key = `${plan.trace.deliveryId}:${plan.commitSha}:${plan.planDigest}`;
	let receipt: SyncReceipt | undefined;
	let applyClaimId: string | undefined;
	if (ctx.storage.sync_receipts) {
		receipt = await prepareSyncReceipt(plan, plan.trace.actorId);
		const won = await persistSyncReceipt(ctx.storage.sync_receipts, receipt);
		if (!won) {
			const existing = await readSyncReceipt(ctx.storage.sync_receipts, receipt.receiptId);
			if (!existing) fail("RECEIPT_PERSISTENCE");
			if (
				existing.planDigest !== plan.planDigest ||
				existing.trustedActorId !== plan.trace.actorId ||
				stableStringify(
					existing.operations.map(
						({ pre: _pre, post: _post, rollback: _rollback, media: _media, ...operation }) =>
							operation,
					),
				) !== stableStringify(receipt.operations)
			)
				fail("RECEIPT_IDENTITY");
			receipt = existing;
		}
		if (receipt.state === "prepared" || receipt.state === "verification-failed") {
			const claimDigest = await contentHash({ receiptId: receipt.receiptId });
			applyClaimId = `apply:${claimDigest}`;
			const claimed = await ctx.storage.sync_receipts.create(applyClaimId, {
				kind: "apply-claim",
				receiptId: receipt.receiptId,
			});
			if (!claimed) fail("RECEIPT_IN_PROGRESS");
		}
	}
	const prior = await ctx.storage.sync_runs.get(key);
	if (prior?.data && typeof prior.data === "object") {
		const record = readRunRecord(prior.data);
		if (!record) fail("REPLAY_RECORD");
		if (record.planDigest !== plan.planDigest) fail("IDEMPOTENCY");
		if (record.status === "succeeded" || record.status === "conflict")
			return {
				version: 1,
				planDigest: plan.planDigest,
				status: record.status,
				results: record.results ?? [],
				uploadedMediaIds: record.uploadedMediaIds ?? [],
				warnings: record.warnings ?? [],
			};
	}
	const record: SyncRunRecord =
		prior?.data && typeof prior.data === "object"
			? { ...(prior.data as SyncRunRecord), status: "running" }
			: {
					status: "running",
					planDigest: plan.planDigest,
					completed: [],
					results: [],
					uploadedMediaIds: [],
					warnings: [],
				};
	const mediaManifest = new Map(readMediaManifest(plan).map((entry) => [entry.sourcePath, entry]));
	for (const action of plan.actions) {
		if (action.kind === "removal-quarantine" && record.warnings.length < MAX_WARNINGS)
			record.warnings.push(boundedWarning(`removal-quarantine:${action.path}`));
		if (action.kind === "rename-quarantine" && record.warnings.length < MAX_WARNINGS)
			record.warnings.push(boundedWarning(`rename-quarantine:${action.previousPath}`));
	}
	await ctx.storage.sync_runs.put(key, record);
	try {
		for (let index = 0; index < plan.commands.length; index += 1) {
			if (record.completed.includes(index)) continue;
			try {
				const command = plan.commands[index];
				const mapping = await findMapping(ctx, command);
				if (receipt && ctx.storage.sync_receipts) {
					const operation = receipt.operations[index];
					if (operation && mapping && ctx.content) {
						const before = await ctx.content.get(mapping.collection, mapping.emdashId);
						if (!before || before.revision !== mapping.revision) fail("MAPPING_CONFLICT");
						operation.pre = {
							id: before.id,
							revision: before.revision,
							hash: await contentHash(before.data),
							status: before.status,
						};
						operation.rollback = { data: before.data, publication: before.status ?? "draft" };
					}
					await updateSyncReceipt(ctx.storage.sync_receipts, {
						...receipt,
						updatedAt: new Date().toISOString(),
					});
				}
				const applied = await applyCommand(
					plan,
					ctx,
					command,
					mediaManifest,
					record.uploadedMediaIds,
					mapping,
				);
				if (receipt && applied.item && ctx.content) {
					const verified = await ctx.content.get(command.collection, applied.item.id);
					if (
						!verified ||
						verified.id !== applied.item.id ||
						(verified.revision &&
							applied.item.revision &&
							verified.revision !== applied.item.revision)
					)
						fail("VERIFY_READBACK");
					const observedFields = Object.fromEntries(
						Object.keys(command.fields).map((field) => [field, verified.data[field]]),
					);
					if ((await contentHash(observedFields)) !== (await contentHash(command.fields)))
						fail("VERIFY_CONTENT_HASH");
					if ((command.publishState === "published") !== (verified.status === "published"))
						fail("VERIFY_PUBLICATION");
					applied.item = verified ?? applied.item;
				}
				const result = applied.result;
				record.results.push(result);
				record.completed.push(index);
				if (applied.item && command.contentId)
					await ctx.storage.sync_mappings.put(
						mappingKey(command),
						mappingFor(command, applied.item, plan, result.uploadedMediaIds),
					);
				if (receipt && applied.item && ctx.storage.sync_receipts) {
					const operation = receipt.operations[index];
					if (operation) {
						operation.post = {
							id: applied.item.id,
							revision: applied.item.revision,
							hash: await contentHash(applied.item.data),
							status: applied.item.status,
						};
						if (result.uploadedMediaIds.length > 0) {
							if (!ctx.media) fail("MEDIA_CAPABILITY");
							if (result.uploadedMediaIds.length !== command.media.length)
								fail("MEDIA_VERIFY_COUNT");
							operation.media = [];
							for (
								let mediaIndex = 0;
								mediaIndex < result.uploadedMediaIds.length;
								mediaIndex += 1
							) {
								const id = result.uploadedMediaIds[mediaIndex];
								const expected = command.media[mediaIndex]?.sha256;
								const persisted = await ctx.media.get(id);
								if (!persisted || persisted.id !== id || !expected || persisted.sha256 !== expected)
									fail("MEDIA_VERIFY");
								operation.media.push({ id, sha256: expected });
							}
						}
					}
					await updateSyncReceipt(ctx.storage.sync_receipts, {
						...receipt,
						state: "prepared",
						updatedAt: new Date().toISOString(),
					});
				}
				if (mapping && mapping.sourceKey !== mappingKey(command))
					await ctx.storage.sync_mappings.delete(mapping.sourceKey);
				await ctx.storage.sync_runs.put(key, record);
			} catch (error) {
				const status = isConflict(error) ? "conflict" : "failed";
				const commandResult = resultFor(plan.commands[index], status, {
					errorCode: stableErrorCode(error),
					errorMessage: "Synchronization was not applied",
				});
				record.results.push(commandResult);
				record.status = status;
				if (record.warnings.length < MAX_WARNINGS)
					record.warnings.push(
						boundedWarning(status === "conflict" ? "revision-conflict" : "apply-failed"),
					);
				if (record.uploadedMediaIds.length > 0 && record.warnings.length < MAX_WARNINGS)
					record.warnings.push("uploaded-media-unlinked");
				await ctx.storage.sync_runs.put(key, record);
				if (receipt && ctx.storage.sync_receipts) {
					receipt = {
						...receipt,
						state: "verification-failed",
						verification: { checkedAt: new Date().toISOString(), code: stableErrorCode(error) },
						updatedAt: new Date().toISOString(),
					};
					await updateSyncReceipt(ctx.storage.sync_receipts, receipt);
					if (applyClaimId) await ctx.storage.sync_receipts.delete(applyClaimId);
				}
				return {
					version: 1,
					planDigest: plan.planDigest,
					status,
					results: record.results,
					uploadedMediaIds: record.uploadedMediaIds,
					warnings: record.warnings.slice(0, MAX_WARNINGS),
				};
			}
		}
		try {
			for (const action of plan.actions) {
				if (action.kind !== "removal-quarantine") continue;
				const mapping = await findMappingByPath(ctx, action.path);
				if (!mapping || !ctx.content) continue;
				const current = await ctx.content.get(mapping.collection, mapping.emdashId);
				if (!current) fail("MAPPING_CONFLICT");
				if (
					current.revision !== mapping.revision &&
					current.status !== "draft" &&
					current.status !== "unpublished"
				)
					fail("MAPPING_CONFLICT");
				const unpublished =
					current.revision === mapping.revision
						? await ctx.content.unpublish(mapping.collection, mapping.emdashId, {
								expectedRevision: mapping.revision,
							})
						: current;
				await ctx.storage.sync_mappings.put(mapping.sourceKey, {
					...mapping,
					revision: unpublished.revision,
					status: "quarantined",
					publication: "unpublished",
					lastPlanDigest: plan.planDigest,
					lastCommitSha: plan.commitSha,
				});
			}
		} catch (error) {
			if (!isConflict(error)) throw error;
			record.status = "conflict";
			if (record.warnings.length < MAX_WARNINGS) record.warnings.push("revision-conflict");
			await ctx.storage.sync_runs.put(key, record);
			if (receipt && ctx.storage.sync_receipts) {
				receipt = {
					...receipt,
					state: "verification-failed",
					verification: { checkedAt: new Date().toISOString(), code: "REVISION_CONFLICT" },
					updatedAt: new Date().toISOString(),
				};
				await updateSyncReceipt(ctx.storage.sync_receipts, receipt);
				if (applyClaimId) await ctx.storage.sync_receipts.delete(applyClaimId);
			}
			return {
				version: 1,
				planDigest: plan.planDigest,
				status: "conflict",
				results: record.results,
				uploadedMediaIds: record.uploadedMediaIds,
				warnings: record.warnings.slice(0, MAX_WARNINGS),
			};
		}
		record.status = "succeeded";
		await ctx.storage.sync_runs.put(key, record);
		if (receipt && ctx.storage.sync_receipts) {
			receipt = {
				...receipt,
				state: "verified",
				verification: { checkedAt: new Date().toISOString() },
				updatedAt: new Date().toISOString(),
			};
			await updateSyncReceipt(ctx.storage.sync_receipts, receipt);
			receipt = { ...receipt, state: "rollback-eligible", updatedAt: new Date().toISOString() };
			await updateSyncReceipt(ctx.storage.sync_receipts, receipt);
		}
		return {
			version: 1,
			planDigest: plan.planDigest,
			status: "succeeded",
			results: record.results,
			uploadedMediaIds: record.uploadedMediaIds,
			warnings: record.warnings.slice(0, MAX_WARNINGS),
		};
	} catch (error) {
		record.status = "failed";
		await ctx.storage.sync_runs.put(key, record);
		if (applyClaimId && ctx.storage.sync_receipts)
			await ctx.storage.sync_receipts.delete(applyClaimId);
		throw error;
	}
}

export async function applySyncPlan(
	input: unknown,
	ctx: ApplyContext,
): Promise<ContentSyncApplyResult> {
	const plan = await validateSyncPlan(input);
	const key = `${plan.trace.deliveryId}:${plan.commitSha}:${plan.planDigest}`;
	let activeRuns = activeRunsByStorage.get(ctx.storage);
	if (!activeRuns) {
		activeRuns = new Map();
		activeRunsByStorage.set(ctx.storage, activeRuns);
	}
	const active = activeRuns.get(key);
	if (active) return active;
	const run = applyValidatedPlan(plan, ctx);
	activeRuns.set(key, run);
	try {
		return await run;
	} finally {
		if (activeRuns.get(key) === run) activeRuns.delete(key);
	}
}
