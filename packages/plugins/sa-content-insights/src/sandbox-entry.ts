import type { MetricSnapshot } from "@signal-alchemist/marketing-automation-contracts";
import type { SandboxedPlugin } from "emdash/plugin";

import {
	normalizeSnapshotEnvelope,
	stableEnvelopeJson,
	type SnapshotEnvelope,
} from "./snapshot-contract.js";
import { readStoredSnapshot, type StoredSnapshot } from "./summary-contract.js";

type StoredRecord = Record<string, unknown> & { id: string; targetKey: string; digest: string };
type SnapshotStore = {
	get: (id: string) => Promise<unknown>;
	query: (options?: unknown) => Promise<{
		items: Array<{ id?: string; data?: unknown }>;
		cursor?: string;
		hasMore?: boolean;
	}>;
	put: (id: string, value: Record<string, unknown>) => Promise<void>;
};
const SUMMARY_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SUMMARY_PATH = /^\/[a-z][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9-]{0,127}$/u;
const MAX_STORED_SNAPSHOTS = 1_000;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_METRIC_ID = /^[a-z][a-z0-9_.-]{0,63}$/u;
const COLLECTION_ID = /^[a-z][a-z0-9_-]{0,62}$/u;
const LOCALE_ID = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;
const CONTENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const FORMULA_ID = /^[a-z][a-z0-9_.-]{0,127}$/u;
const MIN_DIAGNOSIS_DENOMINATOR = 30;
function sortedStrings(values: string[]): string[] {
	const output: string[] = [];
	for (const value of values) {
		let index = 0;
		while (index < output.length && output[index] < value) index += 1;
		if (output[index] !== value) output.splice(index, 0, value);
	}
	return output;
}
function definitionKey(record: StoredSnapshot): string {
	return JSON.stringify(
		record.definitions.map((d) => ({
			id: d.id,
			unit: d.unit,
			source: d.source,
			numerator: d.numerator,
			denominator: d.denominator,
		})),
	);
}
function orderedRecords(records: StoredSnapshot[]): StoredSnapshot[] {
	const output: StoredSnapshot[] = [];
	for (const record of records) {
		let index = 0;
		while (
			index < output.length &&
			((output[index].generatedAt ?? "") > (record.generatedAt ?? "") ||
				((output[index].generatedAt ?? "") === (record.generatedAt ?? "") &&
					output[index].snapshotId < record.snapshotId))
		)
			index += 1;
		output.splice(index, 0, record);
	}
	return output;
}

function strictStoredTime(value: unknown): boolean {
	if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value)))
		return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

type SummaryInput = {
	collection: string;
	locale: string;
	contentId: string;
	path: string;
	source?: string;
	formulaVersion?: string;
	metricIds?: string[];
	asOf?: string;
	window: { from: string; to: string };
	limit?: number;
	cursor?: string;
};

function readSummaryInput(input: unknown): SummaryInput {
	if (!plain(input)) throw new Error("SUMMARY_INPUT_INVALID");
	const keys = Object.keys(input);
	if (
		keys.some(
			(key) =>
				![
					"collection",
					"locale",
					"contentId",
					"path",
					"source",
					"formulaVersion",
					"metricIds",
					"asOf",
					"window",
					"limit",
					"cursor",
				].includes(key),
		)
	)
		throw new Error("SUMMARY_INPUT_EXCESS");
	if (
		typeof input.collection !== "string" ||
		typeof input.locale !== "string" ||
		typeof input.contentId !== "string" ||
		typeof input.path !== "string" ||
		(input.source !== undefined &&
			(typeof input.source !== "string" || input.source.length > 64)) ||
		(input.formulaVersion !== undefined &&
			(typeof input.formulaVersion !== "string" || input.formulaVersion.length > 128)) ||
		(input.metricIds !== undefined &&
			(!Array.isArray(input.metricIds) ||
				input.metricIds.length > 100 ||
				input.metricIds.some((id) => typeof id !== "string" || !SAFE_METRIC_ID.test(id)))) ||
		(input.asOf !== undefined &&
			(typeof input.asOf !== "string" || !strictStoredTime(input.asOf))) ||
		!plain(input.window) ||
		Object.keys(input.window).some((key) => !["from", "to"].includes(key)) ||
		typeof input.window.from !== "string" ||
		typeof input.window.to !== "string" ||
		!SUMMARY_ISO.test(input.window.from) ||
		!SUMMARY_ISO.test(input.window.to) ||
		!strictStoredTime(input.window.from) ||
		!strictStoredTime(input.window.to) ||
		!Number.isFinite(Date.parse(input.window.from)) ||
		!Number.isFinite(Date.parse(input.window.to)) ||
		Date.parse(input.window.from) >= Date.parse(input.window.to) ||
		Date.parse(input.window.to) - Date.parse(input.window.from) > 366 * 86_400_000 ||
		!SUMMARY_PATH.test(input.path) ||
		input.locale.length > 16 ||
		input.contentId.length > 128 ||
		!COLLECTION_ID.test(input.collection) ||
		!LOCALE_ID.test(input.locale) ||
		!CONTENT_ID.test(input.contentId) ||
		(input.source !== undefined && !SOURCE_ID.test(input.source)) ||
		(input.formulaVersion !== undefined && !FORMULA_ID.test(input.formulaVersion)) ||
		(input.metricIds !== undefined && new Set(input.metricIds).size !== input.metricIds.length)
	)
		throw new Error("SUMMARY_INPUT_INVALID");
	const limit = input.limit;
	if (
		limit !== undefined &&
		(typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
	)
		throw new Error("SUMMARY_LIMIT_INVALID");
	if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 512))
		throw new Error("SUMMARY_CURSOR_INVALID");
	return {
		collection: input.collection,
		locale: input.locale,
		contentId: input.contentId,
		path: input.path,
		source: typeof input.source === "string" ? input.source : undefined,
		formulaVersion: typeof input.formulaVersion === "string" ? input.formulaVersion : undefined,
		metricIds: input.metricIds === undefined ? undefined : [...new Set(input.metricIds)],
		asOf: typeof input.asOf === "string" ? input.asOf : undefined,
		window: { from: input.window.from, to: input.window.to },
		limit: typeof limit === "number" ? limit : 50,
		cursor: typeof input.cursor === "string" ? input.cursor : undefined,
	};
}

function summarizeRecords(
	input: SummaryInput,
	result: { items: Array<{ id?: string; data?: unknown }>; cursor?: string; hasMore?: boolean },
): Record<string, unknown> {
	if (!Array.isArray(result.items) || result.items.length > 101)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	const targetKey = `${input.contentId}:${input.path}`;
	const records: StoredSnapshot[] = result.items
		.map((item) => {
			if (!plain(item) || !plain(item.data)) throw new Error("SUMMARY_STORAGE_CORRUPT");
			return readStoredSnapshot(item.data);
		})
		.filter(
			(record) =>
				record.collection === input.collection &&
				record.locale === input.locale &&
				record.targetKey === targetKey &&
				(input.source === undefined || record.source === input.source) &&
				(input.formulaVersion === undefined || record.formulaVersion === input.formulaVersion) &&
				plain(record.window) &&
				record.window.from === input.window.from &&
				record.window.to === input.window.to,
		);
	const pageHasMore = result.items.length > (input.limit ?? 50);
	const pageRecords = orderedRecords(records).slice(0, input.limit ?? 50);
	const sources = sortedStrings([...new Set(pageRecords.map((record) => record.source))]);
	const formulas = sortedStrings([...new Set(pageRecords.map((record) => record.formulaVersion))]);
	const baselineKey = pageRecords[0]
		? `${pageRecords[0].formulaVersion}|${definitionKey(pageRecords[0])}|${plain(pageRecords[0].funnel) && typeof pageRecords[0].funnel.currency === "string" ? pageRecords[0].funnel.currency : ""}`
		: "";
	const compatibleRecords = pageRecords.filter(
		(record) =>
			`${record.formulaVersion}|${definitionKey(record)}|${plain(record.funnel) && typeof record.funnel.currency === "string" ? record.funnel.currency : ""}` ===
			baselineKey,
	);
	const groupKeys = sortedStrings([
		...new Set(
			pageRecords.map(
				(record) =>
					`${record.formulaVersion}|${definitionKey(record)}|${plain(record.funnel) && typeof record.funnel.currency === "string" ? record.funnel.currency : ""}`,
			),
		),
	]);
	const aggregateFunnel: Record<string, number> = {};
	for (const record of compatibleRecords) {
		if (!plain(record.funnel)) continue;
		for (const [key, value] of Object.entries(record.funnel))
			if (typeof value === "number" && Number.isFinite(value) && value >= 0)
				aggregateFunnel[key] = (aggregateFunnel[key] ?? 0) + value;
	}
	const summaries = pageRecords.map((record) => {
		const funnel = plain(record.funnel) ? record.funnel : {};
		const custom = plain(record.custom) ? record.custom : {};
		const uncertainty: string[] = [];
		if (record.sampleWarnings && Array.isArray(record.sampleWarnings)) {
			if (record.sampleWarnings.includes("LOW_SAMPLE")) uncertainty.push("sample_threshold");
			if (record.sampleWarnings.includes("PARTIAL_WINDOW")) uncertainty.push("partial_window");
		}
		const metrics: Record<string, number | null> = {};
		for (const [key, value] of Object.entries(custom)) {
			if (input.metricIds !== undefined && !input.metricIds.includes(key)) continue;
			if (typeof value !== "number") {
				metrics[key] = null;
				continue;
			}
			const definition = Array.isArray(record.definitions)
				? record.definitions.find((candidate) => plain(candidate) && candidate.id === key)
				: null;
			if (
				plain(definition) &&
				definition.unit === "ratio" &&
				definition.denominator &&
				typeof funnel[String(definition.denominator)] === "number" &&
				funnel[String(definition.denominator)] === 0
			) {
				metrics[key] = null;
				uncertainty.push("zero_denominator");
			} else metrics[key] = value;
		}
		if (
			typeof record.importedAt === "string" &&
			typeof record.freshness === "object" &&
			plain(record.freshness) &&
			typeof record.freshness.maxAgeSeconds === "number" &&
			Date.parse(input.asOf ?? new Date().toISOString()) - Date.parse(record.freshness.observedAt) >
				record.freshness.maxAgeSeconds * 1000
		)
			uncertainty.push("stale");
		if (formulas.length > 1) uncertainty.push("incompatible_definition");
		if (sources.length > 1) uncertainty.push("conflicting_source");
		const stepPairs = [
			["impressions", "clicks"],
			["ctaExposures", "ctaClicks"],
			["ctaClicks", "formStarts"],
			["formStarts", "conversions"],
		] as const;
		const diagnosis = stepPairs.map(([denominatorKey, numeratorKey]) => {
			const denominator =
				typeof funnel[denominatorKey] === "number" ? (funnel[denominatorKey] as number) : null;
			const numerator =
				typeof funnel[numeratorKey] === "number" ? (funnel[numeratorKey] as number) : null;
			const rate =
				record.sampleWarnings.includes("LOW_SAMPLE") ||
				denominator === null ||
				denominator < MIN_DIAGNOSIS_DENOMINATOR ||
				numerator === null ||
				numerator > denominator
					? null
					: numerator / denominator;
			return {
				id: numeratorKey,
				numerator,
				denominator,
				rate,
				dropOff: rate === null ? null : 1 - rate,
			};
		});
		const eligible = diagnosis.filter((step) => step.rate !== null);
		const bottleneck =
			eligible.length === 0
				? null
				: eligible.reduce((best, step) => ((step.rate ?? 1) < (best.rate ?? 1) ? step : best)).id;
		return {
			snapshotId: typeof record.snapshotId === "string" ? record.snapshotId : "",
			digest: record.digest,
			metrics,
			funnel: {
				impressions: funnel.impressions ?? null,
				clicks: funnel.clicks ?? null,
				sessions: funnel.sessions ?? null,
				pageViews: funnel.pageViews ?? null,
				ctaExposures: funnel.ctaExposures ?? null,
				ctaClicks: funnel.ctaClicks ?? null,
				formStarts: funnel.formStarts ?? null,
				conversions: funnel.conversions ?? null,
				revenueMinor: funnel.revenueMinor ?? null,
				currency: typeof funnel.currency === "string" ? funnel.currency : null,
			},
			diagnosis,
			bottleneck,
			evidence: {
				content: {
					id: input.contentId,
					collection: input.collection,
					locale: input.locale,
					path: input.path,
				},
				source: record.source,
				formulaVersion: record.formulaVersion,
				window: { ...record.window },
				importedAt: record.importedAt,
				freshness: { ...record.freshness },
				definitionIds: record.definitions.map((definition) => String(definition.id)),
				sampleWarnings: [...record.sampleWarnings],
				digest: record.digest,
			},
			uncertainty,
		};
	});
	return {
		content: {
			id: input.contentId,
			collection: input.collection,
			locale: input.locale,
			path: input.path,
		},
		source: sources.length === 1 ? sources[0] : undefined,
		formulaVersion: formulas.length === 1 ? formulas[0] : undefined,
		formulaVersions: formulas,
		window: input.window,
		asOf: input.asOf,
		sources,
		funnel: groupKeys.length === 1 ? aggregateFunnel : {},
		groups: groupKeys.map((key) => {
			const members = pageRecords.filter(
				(record) =>
					`${record.formulaVersion}|${definitionKey(record)}|${plain(record.funnel) && typeof record.funnel.currency === "string" ? record.funnel.currency : ""}` ===
					key,
			);
			const first = members[0];
			return {
				source: first?.source ?? "",
				formulaVersion: first?.formulaVersion ?? "",
				currency:
					plain(first?.funnel) && typeof first.funnel.currency === "string"
						? first.funnel.currency
						: undefined,
				definitionIds: first?.definitions.map((definition) => String(definition.id)) ?? [],
				snapshotIds: members.map((record) => record.snapshotId),
			};
		}),
		uncertainty: [
			...(formulas.length > 1 ? ["incompatible_definition"] : []),
			...(sources.length > 1 ? ["conflicting_source"] : []),
		],
		freshness: pageRecords.map((record) => {
			if (
				!plain(record.freshness) ||
				typeof record.freshness.observedAt !== "string" ||
				typeof record.freshness.maxAgeSeconds !== "number"
			)
				throw new Error("SUMMARY_STORAGE_CORRUPT");
			return {
				observedAt: record.freshness.observedAt,
				maxAgeSeconds: record.freshness.maxAgeSeconds,
			};
		}),
		definitions: pageRecords.flatMap((record) =>
			Array.isArray(record.definitions)
				? record.definitions.flatMap((definition) => {
						if (
							!plain(definition) ||
							typeof definition.id !== "string" ||
							typeof definition.label !== "string" ||
							typeof definition.unit !== "string" ||
							typeof definition.source !== "string"
						)
							return [];
						const normalized: Record<string, unknown> = {
							id: definition.id,
							label: definition.label,
							unit: definition.unit,
							source: definition.source,
						};
						if (typeof definition.numerator === "string")
							normalized.numerator = definition.numerator;
						if (typeof definition.denominator === "string")
							normalized.denominator = definition.denominator;
						return [normalized];
					})
				: [],
		),
		summaries,
		evidence: pageRecords.map((record) => ({
			snapshotId: record.snapshotId,
			digest: record.digest,
			content: {
				id: input.contentId,
				collection: input.collection,
				locale: input.locale,
				path: input.path,
			},
			source: record.source,
			formulaVersion: record.formulaVersion,
			window: { ...record.window },
			importedAt: record.importedAt,
			freshness: { ...record.freshness },
			sampleWarnings: [...record.sampleWarnings],
			definitionIds: Array.isArray(record.definitions)
				? record.definitions.map((definition) => (plain(definition) ? definition.id : ""))
				: [],
		})),
		nextCursor: pageHasMore ? result.cursor : undefined,
		hasMore: pageHasMore,
	};
}
const COLLECTION_TYPE: Record<string, string> = { posts: "post", pages: "page" };
async function handleSummary(
	routeCtx: { input: unknown },
	ctx: {
		content?: { get?: (collection: string, id: string) => Promise<unknown> };
		storage: { snapshots: SnapshotStore };
	},
): Promise<Record<string, unknown>> {
	const input = readSummaryInput(routeCtx.input);
	if (!ctx.content?.get) throw new Error("CONTENT_READ_REQUIRED");
	const item = await ctx.content.get(input.collection, input.contentId).catch(() => {
		throw new Error("SUMMARY_CONTENT_READ_FAILED");
	});
	if (!plain(item) || item.id !== input.contentId || item.status !== "published")
		throw new Error("SUMMARY_CONTENT_NOT_PUBLISHED");
	if (item.locale !== input.locale) throw new Error("SUMMARY_CONTENT_LOCALE_MISMATCH");
	if (COLLECTION_TYPE[input.collection] !== item.type)
		throw new Error("SUMMARY_CONTENT_TYPE_INVALID");
	if (item.slug !== input.path.slice(input.path.lastIndexOf("/") + 1))
		throw new Error("SUMMARY_CONTENT_PATH_MISMATCH");
	const result = await ctx.storage.snapshots
		.query({
			where: { targetKey: `${input.contentId}:${input.path}` },
			orderBy: { generatedAt: "desc", snapshotId: "asc" },
			limit: (input.limit ?? 50) + 1,
			cursor: input.cursor,
		})
		.catch(() => {
			throw new Error("SUMMARY_STORAGE_READ_FAILED");
		});
	return summarizeRecords(input, result);
}
type ContentTarget = Extract<MetricSnapshot["target"], { kind: "content" }>;

function contentTarget(snapshot: MetricSnapshot): ContentTarget {
	if (snapshot.target.kind !== "content") throw new Error("SNAPSHOT_TARGET_CONTENT_REQUIRED");
	return snapshot.target;
}

function readRecord(input: unknown, kind: "proposal" | "experiment"): StoredRecord {
	if (!input || typeof input !== "object") throw new Error(`${kind} payload is required`);
	const value = input as Record<string, unknown>;
	if (typeof value.id !== "string" || value.id.length === 0)
		throw new Error(`${kind}.id is required`);
	if (typeof value.targetKey !== "string" || value.targetKey.length === 0)
		throw new Error(`${kind}.targetKey is required`);
	return value as StoredRecord;
}

function plain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function digestEnvelope(envelope: SnapshotEnvelope): Promise<string> {
	const bytes = new TextEncoder().encode(stableEnvelopeJson(envelope));
	return globalThis.crypto.subtle
		.digest("SHA-256", bytes)
		.then(
			(digest) =>
				`sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
		);
}

function assertPublishedContent(item: unknown, envelope: SnapshotEnvelope): void {
	if (!plain(item) || item.status !== "published")
		throw new Error("SNAPSHOT_CONTENT_NOT_PUBLISHED");
	const snapshot = envelope.snapshot;
	if (snapshot.target.kind !== "content") throw new Error("SNAPSHOT_TARGET_CONTENT_REQUIRED");
	if (item.id !== snapshot.target.contentId) throw new Error("SNAPSHOT_CONTENT_ID_MISMATCH");
	if (item.locale !== envelope.locale) throw new Error("SNAPSHOT_CONTENT_LOCALE_MISMATCH");
	if (
		typeof item.type !== "string" ||
		item.type.length === 0 ||
		item.type.length > 64 ||
		COLLECTION_TYPE[envelope.collection] !== item.type
	)
		throw new Error("SNAPSHOT_CONTENT_TYPE_INVALID");
	if (typeof item.slug !== "string" || !SAFE_SLUG.test(item.slug))
		throw new Error("SNAPSHOT_CONTENT_SLUG_INVALID");
	if (snapshot.target.path !== `/${envelope.collection}/${item.slug}`)
		throw new Error("SNAPSHOT_CONTENT_PATH_MISMATCH");
}

function storedValue(
	envelope: SnapshotEnvelope,
	digest: string,
	previousDigest?: string,
): Record<string, unknown> {
	const snapshot: MetricSnapshot = envelope.snapshot;
	const target = contentTarget(snapshot);
	const value: Record<string, unknown> = {
		version: snapshot.version,
		snapshotId: snapshot.snapshotId,
		collection: envelope.collection,
		locale: envelope.locale,
		source: envelope.source,
		formulaVersion: envelope.formulaVersion,
		importedAt: envelope.importedAt,
		freshness: envelope.freshness,
		target,
		targetKey: `${target.contentId}:${target.path}`,
		window: snapshot.window,
		definitions: snapshot.definitions,
		funnel: snapshot.funnel,
		custom: snapshot.custom,
		sampleWarnings: snapshot.sampleWarnings,
		generatedAt: snapshot.generatedAt,
		digest,
	};
	if (snapshot.sourceCommit !== undefined) value.sourceCommit = snapshot.sourceCommit;
	if (previousDigest !== undefined) value.previousDigest = previousDigest;
	readStoredSnapshot(value);
	return value;
}

function sameIdentity(existing: Record<string, unknown>, envelope: SnapshotEnvelope): boolean {
	const target = contentTarget(envelope.snapshot);
	return (
		existing.targetKey === `${target.contentId}:${target.path}` &&
		existing.collection === envelope.collection &&
		existing.locale === envelope.locale &&
		existing.source === envelope.source &&
		existing.formulaVersion === envelope.formulaVersion &&
		JSON.stringify(existing.window) === JSON.stringify(envelope.snapshot.window)
	);
}

function validateExisting(existing: Record<string, unknown>, envelope: SnapshotEnvelope): void {
	if (
		existing.snapshotId !== envelope.snapshot.snapshotId ||
		typeof existing.digest !== "string" ||
		!DIGEST.test(existing.digest) ||
		typeof existing.generatedAt !== "string" ||
		typeof existing.importedAt !== "string" ||
		typeof existing.targetKey !== "string" ||
		!strictStoredTime(existing.generatedAt) ||
		!strictStoredTime(existing.importedAt)
	)
		throw new Error("SNAPSHOT_STORAGE_CORRUPT");
}

async function ingestSnapshot(
	input: unknown,
	getContent: (collection: string, id: string) => Promise<unknown>,
	store: SnapshotStore,
): Promise<Record<string, unknown>> {
	const envelope = normalizeSnapshotEnvelope(input);
	const snapshot = envelope.snapshot;
	const target = contentTarget(snapshot);
	const item = await getContent(envelope.collection, target.contentId).catch(() => {
		throw new Error("SNAPSHOT_CONTENT_READ_FAILED");
	});
	assertPublishedContent(item, envelope);
	const digest = await digestEnvelope(envelope);
	const existingRaw = await store.get(snapshot.snapshotId).catch(() => {
		throw new Error("SNAPSHOT_STORAGE_READ_FAILED");
	});
	if (
		existingRaw !== null &&
		(!plain(existingRaw) ||
			typeof existingRaw.digest !== "string" ||
			typeof existingRaw.targetKey !== "string" ||
			typeof existingRaw.snapshotId !== "string")
	)
		throw new Error("SNAPSHOT_STORAGE_CORRUPT");
	const existing = plain(existingRaw) ? existingRaw : null;
	if (existing) validateExisting(existing, envelope);
	if (existing?.digest === digest && sameIdentity(existing, envelope))
		return { accepted: false, status: "skipped", snapshotId: snapshot.snapshotId, digest };
	if (existing && !sameIdentity(existing, envelope)) throw new Error("SNAPSHOT_CONFLICT");
	if (
		existing &&
		(typeof existing.generatedAt !== "string" ||
			Date.parse(snapshot.generatedAt) <= Date.parse(existing.generatedAt) ||
			typeof existing.importedAt !== "string" ||
			Date.parse(envelope.importedAt) <= Date.parse(existing.importedAt))
	)
		throw new Error("SNAPSHOT_CONFLICT");
	if (!existing) {
		const result = await store.query({ limit: MAX_STORED_SNAPSHOTS + 1 }).catch(() => {
			throw new Error("SNAPSHOT_STORAGE_READ_FAILED");
		});
		if (
			!plain(result) ||
			!Array.isArray(result.items) ||
			result.items.length > MAX_STORED_SNAPSHOTS + 1 ||
			result.items.some((entry) => !plain(entry))
		)
			throw new Error("SNAPSHOT_STORAGE_CORRUPT");
		if (result.items.length >= MAX_STORED_SNAPSHOTS) throw new Error("SNAPSHOT_STORAGE_LIMIT");
	}
	const previousDigest =
		existing && typeof existing.digest === "string" ? existing.digest : undefined;
	const value = storedValue(envelope, digest, previousDigest);
	await store.put(snapshot.snapshotId, value).catch(() => {
		throw new Error("SNAPSHOT_STORAGE_WRITE_FAILED");
	});
	return { accepted: true, replaced: Boolean(existing), snapshotId: snapshot.snapshotId, digest };
}

export default {
	routes: {
		health: {
			handler: async () => ({ ok: true, plugin: "sa-content-insights", phase: "foundation" }),
		},
		ingestSnapshot: {
			handler: async (routeCtx, ctx) => {
				if (!ctx.content?.get) throw new Error("CONTENT_READ_REQUIRED");
				return ingestSnapshot(
					routeCtx.input,
					ctx.content.get.bind(ctx.content),
					ctx.storage.snapshots as SnapshotStore,
				);
			},
		},
		summary: {
			permission: "content:read",
			handler: handleSummary as never,
		},
		adminSummary: {
			permission: "plugins:manage",
			handler: handleSummary as never,
		},
		ingestProposal: {
			handler: async (routeCtx, ctx) => {
				const proposal = readRecord(routeCtx.input, "proposal");
				const createdAt =
					typeof proposal.createdAt === "string" ? proposal.createdAt : new Date().toISOString();
				const status = typeof proposal.status === "string" ? proposal.status : "proposed";
				await ctx.storage.proposals.put(proposal.id, { ...proposal, status, createdAt });
				return { accepted: true, proposalId: proposal.id, status, createdAt };
			},
		},
		ingestExperiment: {
			handler: async (routeCtx, ctx) => {
				const experiment = readRecord(routeCtx.input, "experiment");
				const updatedAt = new Date().toISOString();
				const status = typeof experiment.status === "string" ? experiment.status : "draft";
				await ctx.storage.experiments.put(experiment.id, { ...experiment, status, updatedAt });
				return { accepted: true, experimentId: experiment.id, status, updatedAt };
			},
		},
		recent: {
			handler: async (_routeCtx, ctx) => {
				const [, proposals, experiments] = await Promise.all([
					ctx.storage.snapshots.query({ orderBy: { generatedAt: "desc" }, limit: 10 }),
					ctx.storage.proposals.query({ orderBy: { createdAt: "desc" }, limit: 10 }),
					ctx.storage.experiments.query({ orderBy: { updatedAt: "desc" }, limit: 10 }),
				]);
				return {
					snapshots: [],
					proposals: proposals.items,
					experiments: experiments.items,
				};
			},
		},
	},
} satisfies SandboxedPlugin;
