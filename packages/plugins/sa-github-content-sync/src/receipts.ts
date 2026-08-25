import { hexDigest, stableStringify, type SyncPlan } from "./planner.js";

const ID = /^[A-Za-z0-9._:-]{1,240}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_OPS = 512;
const MAX_BYTES = 120_000;
const MAX_CONTENT_BYTES = 2_000_000;

export type SyncReceiptState =
	| "prepared"
	| "verified"
	| "verification-failed"
	| "rollback-eligible"
	| "rolled-back"
	| "rollback-conflict"
	| "rollback-failed";

export type SyncReceiptOperation = {
	index: number;
	operation: "upsert" | "rename" | "unpublish" | "delete";
	collection: string;
	contentId: string;
	path: string;
	publication: string;
	intendedDigest: string;
	pre?: { id: string; revision?: string; hash: string; status?: string };
	post?: { id: string; revision?: string; hash: string; status?: string };
	media?: Array<{ id: string; sha256: string }>;
	rollback?: { data: Record<string, unknown>; publication: string };
	rollbackResult?: {
		state: "content-restored" | "completed";
		revision?: string;
		hash: string;
		status?: string;
	};
};

export type SyncReceipt = {
	version: 1;
	receiptId: string;
	deliveryId: string;
	commitSha: string;
	planDigest: string;
	trustedActorId: string;
	state: SyncReceiptState;
	operations: SyncReceiptOperation[];
	createdAt: string;
	updatedAt: string;
	verification?: { checkedAt: string; code?: string };
	rollback?: { reviewedBy: string; rationale: string; at: string };
};
export type ReceiptView = Omit<SyncReceipt, "operations"> & {
	operations: Array<
		Omit<SyncReceiptOperation, "rollback"> & { rollback?: { publication: string } }
	>;
};

export function toReceiptView(receipt: SyncReceipt): ReceiptView {
	return {
		...receipt,
		operations: receipt.operations.map(({ rollback, ...operation }) => ({
			...operation,
			...(rollback ? { rollback: { publication: rollback.publication } } : {}),
		})),
	};
}

export type ReceiptCollection = {
	get(id: string): Promise<{ id: string; data: unknown } | null>;
	create(id: string, data: unknown): Promise<boolean>;
	put(id: string, data: unknown): Promise<void>;
	delete(id: string): Promise<boolean>;
	query(options?: {
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: unknown }>; cursor?: string; hasMore?: boolean }>;
};

export type ReceiptContent = {
	get(
		collection: string,
		id: string,
	): Promise<{
		id: string;
		data: Record<string, unknown>;
		revision?: string;
		status?: string;
	} | null>;
	update(
		collection: string,
		id: string,
		data: Record<string, unknown>,
		options?: { expectedRevision?: string },
	): Promise<{ id: string; data: Record<string, unknown>; revision?: string; status?: string }>;
	unpublish?(
		collection: string,
		id: string,
		options?: { expectedRevision?: string },
	): Promise<{ id: string; data: Record<string, unknown>; revision?: string; status?: string }>;
	publish?(
		collection: string,
		id: string,
		options?: { expectedRevision?: string },
	): Promise<{ id: string; data: Record<string, unknown>; revision?: string; status?: string }>;
};

export type ReceiptMedia = {
	get(id: string): Promise<{ id: string; sha256?: string | null } | null>;
};

function fail(code: string): never {
	throw new Error(`GITHUB_SYNC_RECEIPT_${code}`);
}

function exactPlain(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		fail("CORRUPT");
	const record = value as Record<string, unknown>;
	if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.includes(key)))
		fail("CORRUPT");
	for (const key of Object.keys(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || descriptor.get || descriptor.set) fail("CORRUPT");
	}
	return record;
}

function canonicalDate(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function canonicalContent(value: unknown, seen = new Set<object>(), depth = 0): unknown {
	if (depth > 16) fail("CONTENT_INVALID");
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("CONTENT_INVALID");
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > 4096 || seen.has(value)) fail("CONTENT_INVALID");
		seen.add(value);
		const result = value.map((v) => canonicalContent(v, seen, depth + 1));
		seen.delete(value);
		return result;
	}
	if (typeof value !== "object") fail("INVALID");
	if (Object.getPrototypeOf(value) !== Object.prototype || seen.has(value)) fail("CONTENT_INVALID");
	seen.add(value);
	const out: Record<string, unknown> = {};
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string")) fail("CONTENT_INVALID");
	const stringKeys = keys as string[];
	// eslint-disable-next-line unicorn/no-array-sort -- this package targets ES2022; this is a fresh array.
	stringKeys.sort();
	for (const key of stringKeys) {
		if (key.length > 100) fail("INVALID");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable)
			fail("CONTENT_INVALID");
		out[key] = canonicalContent(descriptor.value, seen, depth + 1);
	}
	seen.delete(value);
	return out;
}

export async function contentHash(data: Record<string, unknown>): Promise<string> {
	const bytes = new TextEncoder().encode(stableStringify(canonicalContent(data)));
	if (bytes.byteLength > MAX_CONTENT_BYTES) fail("CONTENT_OVERSIZE");
	return hexDigest(bytes);
}

function validateReceipt(value: unknown): SyncReceipt {
	const r = exactPlain(value, [
		"version",
		"receiptId",
		"deliveryId",
		"commitSha",
		"planDigest",
		"trustedActorId",
		"state",
		"operations",
		"createdAt",
		"updatedAt",
		"verification",
		"rollback",
	]) as Partial<SyncReceipt>;
	if (
		r.version !== 1 ||
		typeof r.receiptId !== "string" ||
		!ID.test(r.receiptId) ||
		typeof r.deliveryId !== "string" ||
		!ID.test(r.deliveryId) ||
		typeof r.commitSha !== "string" ||
		!COMMIT_SHA.test(r.commitSha) ||
		typeof r.planDigest !== "string" ||
		!SHA256.test(r.planDigest) ||
		typeof r.trustedActorId !== "string" ||
		!ID.test(r.trustedActorId) ||
		!canonicalDate(r.createdAt) ||
		!canonicalDate(r.updatedAt) ||
		!Array.isArray(r.operations) ||
		r.operations.length > MAX_OPS ||
		typeof r.state !== "string"
	)
		fail("CORRUPT");
	if (
		![
			"prepared",
			"verified",
			"verification-failed",
			"rollback-eligible",
			"rolled-back",
			"rollback-conflict",
			"rollback-failed",
		].includes(r.state)
	)
		fail("CORRUPT");
	const operations = r.operations.map((op) => {
		const x = exactPlain(op, [
			"index",
			"operation",
			"collection",
			"contentId",
			"path",
			"publication",
			"intendedDigest",
			"pre",
			"post",
			"media",
			"rollback",
			"rollbackResult",
		]) as SyncReceiptOperation;
		if (
			!Number.isSafeInteger(x.index) ||
			x.index < 0 ||
			!(["upsert", "rename", "unpublish", "delete"] as const).includes(x.operation) ||
			typeof x.collection !== "string" ||
			x.collection.length < 1 ||
			x.collection.length > 128 ||
			typeof x.contentId !== "string" ||
			x.contentId.length > 200 ||
			typeof x.path !== "string" ||
			x.path.length < 1 ||
			x.path.length > 300 ||
			typeof x.publication !== "string" ||
			x.publication.length < 1 ||
			x.publication.length > 32 ||
			typeof x.intendedDigest !== "string" ||
			!SHA256.test(x.intendedDigest)
		)
			fail("CORRUPT");
		let rollback: SyncReceiptOperation["rollback"];
		if (x.rollback !== undefined) {
			const checked = exactPlain(x.rollback, ["data", "publication"]);
			if (typeof checked.publication !== "string") fail("CORRUPT");
			let data: unknown;
			try {
				data = canonicalContent(checked.data);
			} catch {
				fail("CORRUPT");
			}
			if (!data || typeof data !== "object" || Array.isArray(data)) fail("CORRUPT");
			rollback = {
				data: data as Record<string, unknown>,
				publication: checked.publication,
			};
		}
		for (const snapshot of [x.pre, x.post]) {
			if (snapshot === undefined) continue;
			const checked = exactPlain(snapshot, ["id", "revision", "hash", "status"]);
			if (
				typeof checked.id !== "string" ||
				!ID.test(checked.id) ||
				typeof checked.hash !== "string" ||
				!SHA256.test(checked.hash) ||
				(checked.revision !== undefined &&
					(typeof checked.revision !== "string" || checked.revision.length > 200)) ||
				(checked.status !== undefined &&
					(typeof checked.status !== "string" || checked.status.length > 32))
			)
				fail("CORRUPT");
		}
		if (x.rollbackResult !== undefined) {
			const checked = exactPlain(x.rollbackResult, ["state", "revision", "hash", "status"]);
			if (
				(checked.state !== "content-restored" && checked.state !== "completed") ||
				typeof checked.hash !== "string" ||
				!SHA256.test(checked.hash) ||
				(checked.revision !== undefined && typeof checked.revision !== "string") ||
				(checked.status !== undefined && typeof checked.status !== "string")
			)
				fail("CORRUPT");
		}
		if (
			x.media !== undefined &&
			(!Array.isArray(x.media) ||
				x.media.length > 128 ||
				x.media.some(
					(m) =>
						!m ||
						typeof m.id !== "string" ||
						!ID.test(m.id) ||
						typeof m.sha256 !== "string" ||
						!SHA256.test(m.sha256),
				))
		)
			fail("CORRUPT");
		return rollback === undefined ? x : { ...x, rollback };
	});
	if (r.verification !== undefined) {
		const checked = exactPlain(r.verification, ["checkedAt", "code"]);
		if (
			!canonicalDate(checked.checkedAt) ||
			(checked.code !== undefined &&
				(typeof checked.code !== "string" || checked.code.length > 100))
		)
			fail("CORRUPT");
	}
	if (r.rollback !== undefined) {
		const checked = exactPlain(r.rollback, ["reviewedBy", "rationale", "at"]);
		if (
			typeof checked.reviewedBy !== "string" ||
			!ID.test(checked.reviewedBy) ||
			typeof checked.rationale !== "string" ||
			checked.rationale.length < 1 ||
			checked.rationale.length > 500 ||
			!canonicalDate(checked.at)
		)
			fail("CORRUPT");
	}
	const result = { ...r, operations } as SyncReceipt;
	if (new TextEncoder().encode(stableStringify(result)).byteLength > MAX_BYTES) fail("OVERSIZE");
	return result;
}

export async function prepareSyncReceipt(
	plan: SyncPlan,
	actorId: string,
	now = new Date().toISOString(),
): Promise<SyncReceipt> {
	if (!ID.test(actorId)) fail("ACTOR");
	const receiptId = `${plan.trace.deliveryId}:${plan.commitSha}:${plan.planDigest}`;
	const operations = await Promise.all(
		plan.commands.map(async (command, index) => ({
			index,
			operation: command.operation,
			collection: command.collection,
			contentId: command.contentId ?? "",
			path: command.source.path,
			publication: command.publishState,
			intendedDigest: await contentHash(command.fields),
		})),
	);
	return {
		version: 1,
		receiptId,
		deliveryId: plan.trace.deliveryId,
		commitSha: plan.commitSha,
		planDigest: plan.planDigest,
		trustedActorId: actorId,
		state: "prepared",
		operations,
		createdAt: now,
		updatedAt: now,
	};
}

export async function readSyncReceipt(
	storage: ReceiptCollection,
	id: string,
): Promise<SyncReceipt | null> {
	if (!ID.test(id)) fail("ID");
	const row = await storage.get(id);
	return row ? validateReceipt(row.data) : null;
}

export async function persistSyncReceipt(
	storage: ReceiptCollection,
	receipt: SyncReceipt,
): Promise<boolean> {
	const valid = validateReceipt(receipt);
	return storage.create(receipt.receiptId, valid);
}

export async function claimRollback(
	storage: ReceiptCollection,
	receipt: SyncReceipt,
	reviewedBy: string,
	rationale: string,
	now = new Date().toISOString(),
): Promise<boolean> {
	const digest = await contentHash({ receiptId: receipt.receiptId });
	return storage.create(`rollback:${digest}`, {
		kind: "rollback-claim",
		receiptId: receipt.receiptId,
		reviewedBy,
		rationale,
		createdAt: now,
	});
}

export async function updateSyncReceipt(
	storage: ReceiptCollection,
	receipt: SyncReceipt,
): Promise<void> {
	const valid = validateReceipt({
		...receipt,
		updatedAt: receipt.updatedAt || new Date().toISOString(),
	});
	await storage.put(valid.receiptId, valid);
}

export async function verifySyncReceipt(
	receipt: SyncReceipt,
	content: ReceiptContent,
	media?: ReceiptMedia,
	now = new Date().toISOString(),
): Promise<SyncReceipt> {
	const operations: SyncReceiptOperation[] = [];
	for (const operation of receipt.operations) {
		const targetId = operation.post?.id ?? operation.contentId;
		if (!targetId)
			return {
				...receipt,
				state: "verification-failed",
				verification: { checkedAt: now, code: "CONTENT_ID_MISSING" },
				updatedAt: now,
			};
		const current = await content.get(operation.collection, targetId);
		if (!current)
			return {
				...receipt,
				state: "verification-failed",
				verification: { checkedAt: now, code: "CONTENT_NOT_FOUND" },
				updatedAt: now,
			};
		const hash = await contentHash(current.data);
		if (
			operation.post &&
			(current.revision !== operation.post.revision ||
				hash !== operation.post.hash ||
				current.status !== operation.post.status)
		)
			return {
				...receipt,
				state: "verification-failed",
				verification: { checkedAt: now, code: "CONTENT_POST_MISMATCH" },
				updatedAt: now,
			};
		if (!operation.post && operation.intendedDigest !== hash)
			return {
				...receipt,
				state: "verification-failed",
				verification: { checkedAt: now, code: "CONTENT_HASH_MISMATCH" },
				updatedAt: now,
			};
		if (operation.media?.length) {
			if (!media)
				return {
					...receipt,
					state: "verification-failed",
					verification: { checkedAt: now, code: "MEDIA_VERIFIER_REQUIRED" },
					updatedAt: now,
				};
			for (const expected of operation.media) {
				const persisted = await media.get(expected.id);
				if (
					!persisted ||
					persisted.id !== expected.id ||
					!persisted.sha256 ||
					persisted.sha256 !== expected.sha256
				)
					return {
						...receipt,
						state: "verification-failed",
						verification: { checkedAt: now, code: "MEDIA_POST_MISMATCH" },
						updatedAt: now,
					};
			}
		}
		operations.push({
			...operation,
			post: { id: current.id, revision: current.revision, hash, status: current.status },
		});
	}
	return {
		...receipt,
		operations,
		state: "verified",
		verification: { checkedAt: now },
		updatedAt: now,
	};
}

export async function rollbackSyncReceipt(
	storage: ReceiptCollection,
	receipt: SyncReceipt,
	content: ReceiptContent,
	reviewedBy: string,
	rationale: string,
	now = new Date().toISOString(),
): Promise<SyncReceipt> {
	if (!ID.test(reviewedBy) || rationale.length < 1 || rationale.length > 500) fail("REVIEW");
	let working = (await readSyncReceipt(storage, receipt.receiptId)) ?? receipt;
	if (working.state !== "rollback-eligible" && working.state !== "rollback-failed") fail("STATE");
	const claimId = `rollback:${await contentHash({ receiptId: receipt.receiptId })}`;
	if (!(await claimRollback(storage, receipt, reviewedBy, rationale, now))) {
		const latest = await readSyncReceipt(storage, receipt.receiptId);
		if (latest?.state === "rolled-back") return latest;
		if (
			latest &&
			latest.operations.every(
				(operation) => !operation.post || operation.rollbackResult?.state === "completed",
			)
		) {
			for (const operation of latest.operations) {
				if (!operation.post || !operation.rollbackResult) continue;
				const current = await content.get(operation.collection, operation.post.id);
				if (
					!current ||
					current.revision !== operation.rollbackResult.revision ||
					(await contentHash(current.data)) !== operation.rollbackResult.hash ||
					current.status !== operation.rollbackResult.status
				)
					fail("ROLLBACK_FINALIZE_VERIFY");
			}
			const finalized = {
				...latest,
				state: "rolled-back" as const,
				rollback: { reviewedBy, rationale, at: now },
				updatedAt: now,
			};
			await updateSyncReceipt(storage, finalized);
			return finalized;
		}
		fail("ROLLBACK_IN_PROGRESS");
	}
	let uncheckpointedMutation = false;
	let activeIndex = -1;
	try {
		for (let index = 0; index < working.operations.length; index += 1) {
			const operation = working.operations[index]!;
			if (!operation.post) continue;
			if (operation.rollbackResult?.state === "completed") {
				const completed = await content.get(operation.collection, operation.post.id);
				if (
					!completed ||
					completed.revision !== operation.rollbackResult.revision ||
					(await contentHash(completed.data)) !== operation.rollbackResult.hash ||
					completed.status !== operation.rollbackResult.status
				)
					fail("ROLLBACK_CHECKPOINT_CONFLICT");
				continue;
			}
			const current = await content.get(operation.collection, operation.post.id);
			const expectedCurrentRevision =
				operation.rollbackResult?.state === "content-restored"
					? operation.rollbackResult.revision
					: operation.post.revision;
			if (!current || current.revision !== expectedCurrentRevision) {
				const conflict = {
					...working,
					state: "rollback-conflict" as const,
					rollback: { reviewedBy, rationale, at: now },
					updatedAt: now,
				};
				await updateSyncReceipt(storage, conflict);
				return conflict;
			}
			uncheckpointedMutation = operation.rollbackResult?.state !== "content-restored";
			activeIndex = index;
			let checked: Awaited<ReturnType<ReceiptContent["get"]>> = null;
			if (!operation.pre) {
				if (!content.unpublish) fail("UNPUBLISH_CAPABILITY");
				const quarantined = await content.unpublish(operation.collection, operation.post.id, {
					expectedRevision: operation.post.revision,
				});
				if (quarantined.status === "published") fail("QUARANTINE_VERIFY");
				checked = await content.get(operation.collection, operation.post.id);
				if (!checked || checked.id !== quarantined.id || checked.status === "published")
					fail("QUARANTINE_VERIFY");
			} else {
				if (!operation.rollback) fail("PRIOR_MISSING");
				let restored = current;
				if (operation.rollbackResult?.state !== "content-restored") {
					restored = await content.update(
						operation.collection,
						operation.post.id,
						operation.rollback.data,
						{ expectedRevision: operation.post.revision },
					);
					const restoredRead = await content.get(operation.collection, operation.post.id);
					if (!restoredRead || (await contentHash(restoredRead.data)) !== operation.pre.hash)
						fail("ROLLBACK_CONTENT_VERIFY");
					const operations = [...working.operations];
					operations[index] = {
						...operation,
						rollbackResult: {
							state: "content-restored",
							revision: restoredRead.revision,
							hash: operation.pre.hash,
							status: restoredRead.status,
						},
					};
					working = {
						...working,
						operations,
						state: "rollback-failed",
						rollback: { reviewedBy, rationale, at: now },
						updatedAt: now,
					};
					await updateSyncReceipt(storage, working);
					uncheckpointedMutation = false;
					restored = restoredRead;
				}
				uncheckpointedMutation = true;
				if (operation.rollback.publication === "published") {
					if (!content.publish) fail("PUBLISH_CAPABILITY");
					restored = await content.publish(operation.collection, operation.post.id, {
						expectedRevision: restored.revision,
					});
				} else if (restored.status === "published") {
					if (!content.unpublish) fail("UNPUBLISH_CAPABILITY");
					restored = await content.unpublish(operation.collection, operation.post.id, {
						expectedRevision: restored.revision,
					});
				}
				checked = await content.get(operation.collection, operation.post.id);
				if (
					!checked ||
					checked.id !== restored.id ||
					(await contentHash(checked.data)) !== operation.pre.hash ||
					(operation.rollback.publication === "published") !== (checked.status === "published")
				)
					fail("ROLLBACK_VERIFY");
			}
			if (!checked) fail("ROLLBACK_VERIFY");
			const nextOperation: SyncReceiptOperation = {
				...operation,
				rollbackResult: {
					state: "completed",
					revision: checked.revision,
					hash: await contentHash(checked.data),
					status: checked.status,
				},
			};
			const operations = [...working.operations];
			operations[index] = nextOperation;
			working = {
				...working,
				operations,
				state: "rollback-failed",
				rollback: { reviewedBy, rationale, at: now },
				updatedAt: now,
			};
			await updateSyncReceipt(storage, working);
			uncheckpointedMutation = false;
		}
	} catch (error) {
		if (uncheckpointedMutation && activeIndex >= 0) {
			const operation = working.operations[activeIndex]!;
			try {
				const observed = operation.post
					? await content.get(operation.collection, operation.post.id)
					: null;
				if (observed && operation.post) {
					const observedHash = await contentHash(observed.data);
					if (
						operation.rollbackResult?.state === "content-restored" &&
						observed.revision === operation.rollbackResult.revision &&
						observedHash === operation.rollbackResult.hash &&
						observed.status === operation.rollbackResult.status
					)
						uncheckpointedMutation = false;
					else if (
						observed.revision === operation.post.revision &&
						observedHash === operation.post.hash &&
						observed.status === operation.post.status
					)
						uncheckpointedMutation = false;
					else if (
						(operation.pre &&
							observedHash === operation.pre.hash &&
							(operation.rollback?.publication === "published") ===
								(observed.status === "published")) ||
						(!operation.pre &&
							observedHash === operation.post.hash &&
							observed.status !== "published")
					) {
						const operations = [...working.operations];
						operations[activeIndex] = {
							...operation,
							rollbackResult: {
								state: "completed",
								revision: observed.revision,
								hash: observedHash,
								status: observed.status,
							},
						};
						working = { ...working, operations, updatedAt: now };
						uncheckpointedMutation = false;
					}
				}
			} catch {
				/* fail closed with the durable claim retained */
			}
		}
		const failed = {
			...working,
			state: "rollback-failed" as const,
			rollback: { reviewedBy, rationale, at: now },
			updatedAt: now,
		};
		try {
			await updateSyncReceipt(storage, failed);
		} catch {
			/* keep the claim: mutation outcome is not durably known */
		}
		if (!uncheckpointedMutation) await storage.delete(claimId);
		throw error;
	}
	const result = {
		...working,
		state: "rolled-back" as const,
		rollback: { reviewedBy, rationale, at: now },
		updatedAt: now,
	};
	try {
		await updateSyncReceipt(storage, result);
	} catch (error) {
		try {
			await storage.delete(claimId);
		} catch {
			/* completed checkpoints permit safe finalization retry */
		}
		throw error;
	}
	return result;
}

export async function listSyncReceipts(
	storage: ReceiptCollection,
	options?: { limit?: number; cursor?: string },
) {
	const limit = options?.limit ?? 50;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("LIMIT");
	if (
		options?.cursor !== undefined &&
		(typeof options.cursor !== "string" || options.cursor.length > 512)
	)
		fail("CURSOR");
	const page = await storage.query({ limit, cursor: options?.cursor });
	const items = page.items
		.flatMap((row) => {
			try {
				return [{ id: row.id, data: toReceiptView(validateReceipt(row.data)) }];
			} catch {
				return [];
			}
		})
		// eslint-disable-next-line unicorn/no-array-sort -- flatMap returns a fresh array and ES2022 lacks toSorted.
		.sort((a, b) => {
			const left = a.data.createdAt;
			const right = b.data.createdAt;
			return right.localeCompare(left) || a.id.localeCompare(b.id);
		});
	return { ...page, items };
}
