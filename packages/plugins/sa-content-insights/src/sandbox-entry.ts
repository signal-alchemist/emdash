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
type RecordClaim = {
	version: 1;
	kind: "proposal" | "experiment";
	recordId: string;
	revision: number;
	digest: string;
	record: Record<string, unknown>;
};
const SUMMARY_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SUMMARY_PATH = /^\/[a-z][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9-]{0,127}$/u;
const MAX_STORED_SNAPSHOTS = 1_000;
const MAX_STORED_RECORDS = 1_000;
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
	if (
		!strictRecord(input, [
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
		])
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
				typeof definition.denominator === "string" &&
				typeof funnel[definition.denominator] === "number" &&
				funnel[definition.denominator] === 0
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
				typeof funnel[denominatorKey] === "number" ? funnel[denominatorKey] : null;
			const numerator =
				typeof funnel[numeratorKey] === "number" ? funnel[numeratorKey] : null;
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

const RECORD_STATES = {
	experiment: ["draft", "ready", "running", "observing", "decided", "reverted", "cancelled"],
	proposal: [
		"proposed",
		"needs_review",
		"approved",
		"rejected",
		"implemented",
		"measuring",
		"accepted",
		"reverted",
		"inconclusive",
	],
} as const;
const RECORD_STATE_SET = {
	experiment: new Set(RECORD_STATES.experiment),
	proposal: new Set(RECORD_STATES.proposal),
};
const TRANSITIONS: Record<"experiment" | "proposal", Record<string, Set<string>>> = {
	experiment: {
		draft: new Set(["ready", "cancelled"]),
		ready: new Set(["running", "cancelled"]),
		running: new Set(["observing", "cancelled"]),
		observing: new Set(["decided", "reverted", "cancelled"]),
		decided: new Set(["reverted"]),
		reverted: new Set(),
		cancelled: new Set(),
	},
	proposal: {
		proposed: new Set(["needs_review", "approved", "rejected"]),
		needs_review: new Set(["approved", "rejected"]),
		approved: new Set(["implemented", "rejected"]),
		implemented: new Set(["measuring"]),
		measuring: new Set(["accepted", "inconclusive", "reverted"]),
		accepted: new Set(["reverted"]),
		rejected: new Set(),
		reverted: new Set(),
		inconclusive: new Set(),
	},
};
function transitionAllowed(kind: "proposal" | "experiment", from: string, to: string): boolean {
	return TRANSITIONS[kind][from]?.has(to) ?? false;
}
const FINAL_EXPERIMENT = new Set(["decided", "reverted", "cancelled"]);
const RECORD_KEYS = [
	"version",
	"id",
	"status",
	"revision",
	"targetKey",
	"content",
	"locale",
	"evidence",
	"variants",
	"hypothesis",
	"window",
	"holdout",
	"metrics",
	"changes",
	"risks",
	"verification",
	"uncertainty",
	"decision",
	"actor",
	"createdAt",
	"updatedAt",
	"idempotencyKey",
];
const NESTED_KEYS: Record<string, Set<string>> = {
	variant: new Set(["id", "allocation", "label"]),
	metric: new Set(["id", "unit", "definitionId"]),
	risk: new Set(["id", "severity", "mitigation"]),
	verification: new Set(["id", "method", "threshold"]),
	uncertainty: new Set(["code", "detail"]),
};
function exactNested(value: unknown, kind: keyof typeof NESTED_KEYS, max: number): boolean {
	return (
		Array.isArray(value) &&
		value.length <= max &&
		value.every(
			(entry) =>
				strictRecord(entry, [...NESTED_KEYS[kind]]) &&
				Object.values(entry).every(
					(field) => typeof field === "string" || typeof field === "number",
				),
		)
	);
}
const SHA = /^sha256:[a-f0-9]{64}$/u;
const TEXT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const SAFE_CONTENT_PATH = /^\/[a-z][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9-]{0,127}$/u;
const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,62}$/u;
const LOCALE_NAME = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;
const COLLECTION_TYPE: Record<string, string> = { posts: "post", pages: "page" };
const FINAL_DECISIONS = new Set([
	"winner",
	"loser",
	"approved",
	"rejected",
	"accepted",
	"inconclusive",
	"reverted",
	"cancelled",
]);
const METRIC_UNITS = new Set(["count", "ratio", "currency", "duration", "position"]);
const RISK_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const UNCERTAINTY_CODES = new Set([
	"small_sample",
	"partial_window",
	"stale",
	"conflict",
	"no_data",
]);
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (plain(value))
		return `{${sortedStrings(Object.keys(value))
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** Reject anything other than an ordinary, data-only record before reading it. */
function strictRecord(
	value: unknown,
	allowed?: readonly string[],
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype === null) return false;
	if (prototype !== Object.prototype) {
		const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
		if (
			typeof constructor !== "function" ||
			constructor.name !== "Object" ||
			Function.prototype.toString.call(constructor) !== "function Object() { [native code] }"
		)
			return false;
	}
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") return false;
		if (allowed && !allowed.includes(key)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			!descriptor ||
			!descriptor.enumerable ||
			!("value" in descriptor) ||
			descriptor.get ||
			descriptor.set
		)
			return false;
	}
	return true;
}
function boundedText(value: unknown, max: number): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) return false;
	}
	return true;
}
function exactRecord(input: unknown, kind: "proposal" | "experiment"): StoredRecord {
	if (!strictRecord(input, RECORD_KEYS)) throw new Error("RECORD_INPUT_EXCESS");
	if (
		input.version !== 1 ||
		!boundedText(input.id, 128) ||
		!TEXT_ID.test(input.id) ||
		!RECORD_STATE_SET[kind].has(input.status as never) ||
		!Number.isSafeInteger(input.revision) ||
		(input.revision as number) < 0 ||
		(input.revision as number) > 1_000_000 ||
		!boundedText(input.targetKey, 256)
	)
		throw new Error("RECORD_INPUT_INVALID");
	if (
		!strictRecord(input.content, ["collection", "id", "path"]) ||
		typeof input.content.collection !== "string" ||
		!COLLECTION_TYPE[input.content.collection] ||
		!COLLECTION_NAME.test(input.content.collection) ||
		!strictRecord(input.evidence, [
			"snapshotId",
			"digest",
			"contentId",
			"path",
			"locale",
			"source",
			"formulaVersion",
			"window",
		]) ||
		!LOCALE_NAME.test(String(input.locale)) ||
		!strictRecord(input.evidence, [
			"snapshotId",
			"digest",
			"contentId",
			"path",
			"locale",
			"source",
			"formulaVersion",
			"window",
		]) ||
		!boundedText(input.evidence.snapshotId, 128) ||
		typeof input.evidence.digest !== "string" ||
		!SHA.test(input.evidence.digest) ||
		input.evidence.contentId !== input.content?.id ||
		input.evidence.path !== input.content?.path ||
		input.evidence.locale !== input.locale
	)
		throw new Error("RECORD_EVIDENCE_INVALID");
	if (
		!plain(input.content) ||
		!boundedText(input.content.id, 128) ||
		!boundedText(input.content.path, 256) ||
		!SAFE_CONTENT_PATH.test(input.content.path) ||
		!boundedText(input.locale, 16)
	)
		throw new Error("RECORD_CONTENT_INVALID");
	if (new TextEncoder().encode(canonicalJson(input)).length > 32_768)
		throw new Error("RECORD_INPUT_TOO_LARGE");
	if (input.hypothesis !== undefined && !boundedText(input.hypothesis, 512))
		throw new Error("RECORD_HYPOTHESIS_INVALID");
	if (
		input.variants !== undefined &&
		(!exactNested(input.variants, "variant", 50) ||
			(input.variants as Record<string, unknown>[]).some(
				(variant) =>
					!boundedText(variant.id, 64) ||
					typeof variant.allocation !== "number" ||
					variant.allocation < 0 ||
					variant.allocation > 1,
			))
	)
		throw new Error("RECORD_VARIANTS_INVALID");
	if (
		input.metrics !== undefined &&
		(!exactNested(input.metrics, "metric", 100) ||
			(input.metrics as Record<string, unknown>[]).some(
				(metric) => !boundedText(metric.id, 64) || !boundedText(metric.unit, 32),
			))
	)
		throw new Error("RECORD_METRICS_INVALID");
	if (
		input.risks !== undefined &&
		(!exactNested(input.risks, "risk", 50) ||
			(input.risks as Record<string, unknown>[]).some(
				(risk) =>
					!boundedText(risk.id, 64) ||
					!boundedText(risk.severity, 32) ||
					!boundedText(risk.mitigation, 512),
			))
	)
		throw new Error("RECORD_RISKS_INVALID");
	if (
		input.verification !== undefined &&
		(!exactNested(input.verification, "verification", 50) ||
			(input.verification as Record<string, unknown>[]).some(
				(entry) => !boundedText(entry.id, 64) || !boundedText(entry.method, 256),
			))
	)
		throw new Error("RECORD_VERIFICATION_INVALID");
	if (
		input.uncertainty !== undefined &&
		(!exactNested(input.uncertainty, "uncertainty", 50) ||
			(input.uncertainty as Record<string, unknown>[]).some(
				(entry) =>
					!boundedText(entry.code, 64) ||
					(entry.detail !== undefined && !boundedText(entry.detail, 256)),
			))
	)
		throw new Error("RECORD_UNCERTAINTY_INVALID");
	if (input.variants !== undefined) {
		const variants = input.variants as Record<string, unknown>[];
		if (
			variants.length < 2 ||
			variants.some(
				(variant) =>
					!boundedText(variant.id, 64) ||
					!TEXT_ID.test(variant.id) ||
					!boundedText(variant.label, 128) ||
					typeof variant.allocation !== "number" ||
					!Number.isFinite(variant.allocation) ||
					variant.allocation <= 0,
			) ||
			new Set(variants.map((variant) => variant.id)).size !== variants.length ||
			Math.abs(variants.reduce((sum, variant) => sum + Number(variant.allocation), 0) - 1) >
				0.000001
		)
			throw new Error("RECORD_VARIANTS_INVALID");
	}
	if (input.metrics !== undefined) {
		const metrics = input.metrics as Record<string, unknown>[];
		if (
			metrics.length === 0 ||
			metrics.some(
				(metric) =>
					!boundedText(metric.id, 64) ||
					!TEXT_ID.test(metric.id) ||
					!boundedText(metric.unit, 32) ||
					!METRIC_UNITS.has(metric.unit) ||
					!boundedText(metric.definitionId, 128),
			) ||
			new Set(metrics.map((metric) => metric.id)).size !== metrics.length
		)
			throw new Error("RECORD_METRICS_INVALID");
	}
	if (
		input.risks !== undefined &&
		(input.risks as Record<string, unknown>[]).some(
			(risk) => !RISK_SEVERITIES.has(risk.severity as string),
		)
	)
		throw new Error("RECORD_RISKS_INVALID");
	if (
		input.uncertainty !== undefined &&
		(input.uncertainty as Record<string, unknown>[]).some(
			(entry) => !UNCERTAINTY_CODES.has(entry.code as string),
		)
	)
		throw new Error("RECORD_UNCERTAINTY_INVALID");
	if (
		kind === "experiment" &&
		(!Array.isArray(input.variants) ||
			!Array.isArray(input.metrics) ||
			!boundedText(input.hypothesis, 512))
	)
		throw new Error("RECORD_EXPERIMENT_FIELDS_REQUIRED");
	if (
		kind === "proposal" &&
		(!Array.isArray(input.changes) ||
			input.changes.length === 0 ||
			!Array.isArray(input.risks) ||
			!Array.isArray(input.verification))
	)
		throw new Error("RECORD_PROPOSAL_FIELDS_REQUIRED");
	if (
		kind === "proposal" &&
		["variants", "metrics", "hypothesis", "holdout"].some((key) => Object.hasOwn(input, key))
	)
		throw new Error("RECORD_PROPOSAL_EXCESS");
	if (
		kind === "experiment" &&
		["changes", "risks", "verification"].some((key) => Object.hasOwn(input, key))
	)
		throw new Error("RECORD_EXPERIMENT_EXCESS");
	if (
		input.window !== undefined &&
		(!strictRecord(input.window, ["from", "to"]) ||
			!strictStoredTime(input.window.from) ||
			!strictStoredTime(input.window.to) ||
			String(input.window.from) >= String(input.window.to))
	)
		throw new Error("RECORD_WINDOW_INVALID");
	if (
		input.holdout !== undefined &&
		(!strictRecord(input.holdout, ["enabled", "allocation"]) ||
			typeof input.holdout.enabled !== "boolean" ||
			typeof input.holdout.allocation !== "number" ||
			input.holdout.allocation < 0 ||
			input.holdout.allocation > 1)
	)
		throw new Error("RECORD_HOLDOUT_INVALID");
	if (input.createdAt !== undefined || input.updatedAt !== undefined)
		throw new Error("RECORD_TIME_UNTRUSTED");
	if (
		input.idempotencyKey !== undefined &&
		(!boundedText(input.idempotencyKey, 128) || !TEXT_ID.test(input.idempotencyKey))
	)
		throw new Error("RECORD_IDEMPOTENCY_INVALID");
	if (input.actor !== undefined) throw new Error("RECORD_ACTOR_UNTRUSTED");
	if (
		input.changes !== undefined &&
		(!Array.isArray(input.changes) ||
			input.changes.length > 100 ||
			input.changes.some(
				(change) =>
					!strictRecord(change, ["path", "hash"]) ||
					!boundedText(change.path, 256) ||
					!boundedText(change.hash, 128) ||
					!SHA.test(change.hash),
			))
	)
		throw new Error("RECORD_CHANGES_INVALID");
	const requiresDecision =
		(kind === "experiment" && FINAL_EXPERIMENT.has(input.status as string)) ||
		(kind === "proposal" &&
			new Set(["approved", "rejected", "accepted", "reverted", "inconclusive"]).has(
				input.status as string,
			));
	const decisionOutcome = plain(input.decision) ? input.decision.outcome : undefined;
	const decisionOutcomeValid =
		(kind === "experiment" &&
			((input.status === "decided" &&
				["winner", "loser", "inconclusive"].includes(String(decisionOutcome))) ||
				(input.status === "reverted" && decisionOutcome === "reverted") ||
				(input.status === "cancelled" && decisionOutcome === "cancelled"))) ||
		(kind === "proposal" &&
			((input.status === "approved" && decisionOutcome === "approved") ||
				(input.status === "rejected" && decisionOutcome === "rejected") ||
				(input.status === "accepted" && decisionOutcome === "accepted") ||
				(input.status === "reverted" && decisionOutcome === "reverted") ||
				(input.status === "inconclusive" && decisionOutcome === "inconclusive")));
	if (
		requiresDecision &&
		(!strictRecord(input.decision, ["outcome", "rationale", "evidence"]) ||
			!FINAL_DECISIONS.has(String(input.decision.outcome)) ||
			!boundedText(input.decision.rationale, 1_000) ||
			!Array.isArray(input.decision.evidence) ||
			input.decision.evidence.length > 10 ||
			input.decision.evidence.some((id) => !boundedText(id, 128) || !TEXT_ID.test(id)) ||
			!decisionOutcomeValid)
	)
		throw new Error("RECORD_HUMAN_DECISION_REQUIRED");
	return { ...input, id: input.id, targetKey: input.targetKey } as StoredRecord;
}
async function persistRecord(
	input: unknown,
	kind: "proposal" | "experiment",
	trustedUser: unknown,
	ctx: {
		content: { get: (collection: string, id: string) => Promise<unknown> };
		storage: Record<
			string,
			{
				get: (id: string) => Promise<unknown>;
				count?: () => Promise<number>;
				put: (id: string, value: Record<string, unknown>) => Promise<void>;
				create: (id: string, value: Record<string, unknown>) => Promise<boolean>;
			}
		>;
	},
): Promise<Record<string, unknown>> {
	const record = exactRecord(input, kind);
	if (requiresHumanDecision(kind, String(record.status))) {
		if (!plain(trustedUser) || typeof trustedUser.id !== "string" || !TEXT_ID.test(trustedUser.id))
			throw new Error("RECORD_HUMAN_ACTOR_UNTRUSTED");
		record.actor = { id: trustedUser.id, type: "human" };
	}
	const collection =
		typeof record.content === "object" && record.content && "collection" in record.content
			? String((record.content as Record<string, unknown>).collection)
			: "posts";
	const item = await ctx.content
		.get(collection, String((record.content as Record<string, unknown>).id))
		.catch(() => {
			throw new Error("RECORD_CONTENT_READ_FAILED");
		});
	if (
		!plain(item) ||
		item.status !== "published" ||
		item.id !== (record.content as Record<string, unknown>).id ||
		item.locale !== record.locale ||
		item.type !== COLLECTION_TYPE[String((record.content as Record<string, unknown>).collection)] ||
		item.slug !==
			String((record.content as Record<string, unknown>).path)
				.split("/")
				.pop()
	)
		throw new Error("RECORD_CONTENT_NOT_PUBLISHED");
	const snapshots = ctx.storage.snapshots as unknown as SnapshotStore;
	const storedSnapshot = await snapshots
		.get(String((record.evidence as Record<string, unknown>).snapshotId))
		.catch(() => {
			throw new Error("RECORD_EVIDENCE_READ_FAILED");
		});
	let evidenceSnapshot: StoredSnapshot;
	try {
		evidenceSnapshot = readStoredSnapshot(storedSnapshot);
	} catch {
		throw new Error("RECORD_EVIDENCE_INVALID");
	}
	const evidence = record.evidence as Record<string, unknown>;
	if (
		evidenceSnapshot.digest !== evidence.digest ||
		evidenceSnapshot.targetKey !== record.targetKey ||
		evidenceSnapshot.target.contentId !== evidence.contentId ||
		evidenceSnapshot.target.path !== evidence.path ||
		evidenceSnapshot.locale !== record.locale ||
		evidenceSnapshot.source !== evidence.source ||
		evidenceSnapshot.formulaVersion !== evidence.formulaVersion ||
		canonicalJson(evidenceSnapshot.window) !== canonicalJson(evidence.window) ||
		(evidence.freshness !== undefined &&
			canonicalJson(evidenceSnapshot.freshness) !== canonicalJson(evidence.freshness)) ||
		(evidence.uncertainty !== undefined &&
			canonicalJson(evidenceSnapshot.sampleWarnings) !== canonicalJson(evidence.uncertainty))
	)
		throw new Error("RECORD_EVIDENCE_INVALID");
	const store = ctx.storage[kind === "proposal" ? "proposals" : "experiments"];
	const claims = ctx.storage.record_claims;
	const existingRaw = await store.get(record.id).catch(() => {
		throw new Error("RECORD_STORAGE_READ_FAILED");
	});
	const existing = existingRaw === null ? null : validateStoredRecord(existingRaw, kind);
	if (existing !== null) {
		if (existing.revision === record.revision && commandJson(existing) === commandJson(record))
			return { accepted: false, status: "skipped", id: record.id, revision: record.revision };
		if (
			record.idempotencyKey !== undefined &&
			existing.idempotencyKey === record.idempotencyKey &&
			commandJson(existing) !== commandJson(record)
		)
			throw new Error("RECORD_IDEMPOTENCY_CONFLICT");
		if (
			existing.revision !== (record.revision as number) - 1 ||
			!transitionAllowed(kind, String(existing.status), String(record.status))
		)
			throw new Error("RECORD_REVISION_CONFLICT");
	}
	if (
		existing === null &&
		((kind === "experiment" && record.status !== "draft") ||
			(kind === "proposal" && record.status !== "proposed"))
	)
		throw new Error("RECORD_INITIAL_STATE_INVALID");
	if (existing === null && store.count) {
		const count = await store.count().catch(() => {
			throw new Error("RECORD_STORAGE_READ_FAILED");
		});
		if (!Number.isSafeInteger(count) || count >= MAX_STORED_RECORDS)
			throw new Error("RECORD_STORAGE_LIMIT");
	}
	const now = new Date().toISOString();
	const writtenValue = {
		version: 1,
		...record,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	if (typeof record.id !== "string") throw new Error("RECORD_ID_INVALID");
	const recordId = record.id;
	const revision =
		typeof record.revision === "number"
			? record.revision
			: (() => {
					throw new Error("RECORD_REVISION_INVALID");
				})();
	const claimId = `${String(kind)}:${recordId}:revision:${revision}`;
	const commandDigest = await digestText(commandJson(record));
	let intended: Record<string, unknown> = writtenValue;
	try {
		if (existing !== null) {
			const claimValue: RecordClaim = {
				version: 1,
				kind,
				recordId,
				revision,
				digest: commandDigest,
				record: writtenValue,
			};
			const claimed = await claims.create(claimId, claimValue).catch(() => {
				throw new Error("RECORD_CLAIM_CREATE_FAILED");
			});
			if (!claimed) {
				const rawClaim = await claims.get(claimId).catch(() => {
					throw new Error("RECORD_CLAIM_READ_FAILED");
				});
				const prior = validateRecordClaim(rawClaim, kind, recordId, revision);
				if (prior.digest !== commandDigest) throw new Error("RECORD_REVISION_CONFLICT");
				if ((await digestText(commandJson(prior.record))) !== prior.digest)
					throw new Error("RECORD_CLAIM_CORRUPT");
				intended = prior.record;
			}
		}
		if (existing === null) {
			const claimed = await store.create(record.id, writtenValue);
			if (claimed === false) {
				const winner = await store.get(record.id);
				if (plain(winner) && commandJson(winner) === commandJson(record))
					return { accepted: false, status: "skipped", id: record.id, revision: record.revision };
				throw new Error("RECORD_REVISION_CONFLICT");
			}
		} else {
			await store.put(record.id, intended);
			await claims
				.put(claimId, {
					version: 1,
					kind,
					recordId: record.id,
					revision: record.revision,
					digest: commandDigest,
					record: intended,
				})
				.catch(() => {
					throw new Error("RECORD_CLAIM_WRITE_FAILED");
				});
		}
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "RECORD_IDEMPOTENCY_CONFLICT" ||
				error.message === "RECORD_REVISION_CONFLICT" ||
				error.message === "RECORD_CLAIM_CORRUPT" ||
				error.message === "RECORD_CLAIM_CREATE_FAILED" ||
				error.message === "RECORD_CLAIM_READ_FAILED" ||
				error.message === "RECORD_CLAIM_WRITE_FAILED")
		)
			throw error;
		throw new Error(
			existing === null ? "RECORD_STORAGE_CREATE_FAILED" : "RECORD_STORAGE_WRITE_FAILED",
			{ cause: error },
		);
	}
	const written = await store.get(record.id).catch(() => {
		throw new Error("RECORD_STORAGE_READ_FAILED");
	});
	if (!plain(written) || commandJson(written) !== commandJson(record))
		throw new Error("RECORD_STORAGE_RACE");
	return { accepted: true, id: record.id, status: record.status, revision: record.revision };
}

async function digestText(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validateRecordClaim(
	value: unknown,
	kind: "proposal" | "experiment",
	recordId: string,
	revision: number,
): RecordClaim {
	if (
		!strictRecord(value, ["version", "kind", "recordId", "revision", "digest", "record"]) ||
		value.version !== 1 ||
		value.kind !== kind ||
		value.recordId !== recordId ||
		value.revision !== revision ||
		typeof value.digest !== "string" ||
		!SHA.test(value.digest) ||
		!plain(value.record)
	)
		throw new Error("RECORD_CLAIM_CORRUPT");
	if (new TextEncoder().encode(canonicalJson(value)).length > 32_768)
		throw new Error("RECORD_CLAIM_CORRUPT");
	try {
		validateStoredRecord(value.record, kind);
	} catch {
		throw new Error("RECORD_CLAIM_CORRUPT");
	}
	return value as unknown as RecordClaim;
}

function requiresHumanDecision(kind: "proposal" | "experiment", status: string): boolean {
	return kind === "experiment"
		? FINAL_EXPERIMENT.has(status)
		: new Set(["approved", "rejected", "accepted", "reverted", "inconclusive"]).has(status);
}
function validateStoredRecord(
	value: unknown,
	kind: "proposal" | "experiment",
): Record<string, unknown> {
	if (!strictRecord(value, [...RECORD_KEYS, "createdAt", "updatedAt"]))
		throw new Error("RECORD_STORAGE_CORRUPT");
	if (!strictStoredTime(value.createdAt) || !strictStoredTime(value.updatedAt))
		throw new Error("RECORD_STORAGE_CORRUPT");
	if (
		value.actor !== undefined &&
		(!strictRecord(value.actor, ["id", "type"]) ||
			value.actor.type !== "human" ||
			typeof value.actor.id !== "string" ||
			!TEXT_ID.test(value.actor.id))
	)
		throw new Error("RECORD_STORAGE_CORRUPT");
	const command = { ...value };
	delete command.createdAt;
	delete command.updatedAt;
	delete command.actor;
	try {
		exactRecord(command, kind);
	} catch {
		throw new Error("RECORD_STORAGE_CORRUPT");
	}
	return value;
}
function projectRecord(value: unknown, kind: "proposal" | "experiment"): Record<string, unknown> {
	const stored = validateStoredRecord(value, kind);
	const projection: Record<string, unknown> = {
		version: stored.version,
		id: stored.id,
		status: stored.status,
		revision: stored.revision,
		targetKey: stored.targetKey,
		content: stored.content,
		locale: stored.locale,
		evidence: plain(stored.evidence) ? { ...stored.evidence } : stored.evidence,
		uncertainty: stored.uncertainty,
		actor: plain(stored.actor) ? { id: stored.actor.id, type: stored.actor.type } : undefined,
		updatedAt: stored.updatedAt,
	};
	for (const key of [
		"variants",
		"hypothesis",
		"holdout",
		"metrics",
		"changes",
		"risks",
		"verification",
		"decision",
	])
		if (stored[key] !== undefined) projection[key] = stored[key];
	if (plain(stored.evidence)) {
		if (stored.evidence.freshness !== undefined)
			(projection.evidence as Record<string, unknown>).freshness = stored.evidence.freshness;
		if (stored.evidence.uncertainty !== undefined)
			(projection.evidence as Record<string, unknown>).uncertainty = stored.evidence.uncertainty;
	}
	return projection;
}
function commandJson(value: unknown): string {
	if (!plain(value)) return canonicalJson(value);
	const copy = { ...value };
	delete copy.updatedAt;
	delete copy.createdAt;
	return canonicalJson(copy);
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
			handler: (async (
				routeCtx: { input: unknown; user?: unknown },
				ctx: {
					content?: { get?: (collection: string, id: string) => Promise<unknown> };
					storage: { snapshots: SnapshotStore };
				},
			) => {
				if (!ctx.content?.get) throw new Error("CONTENT_READ_REQUIRED");
				return ingestSnapshot(
					routeCtx.input,
					ctx.content.get.bind(ctx.content),
					ctx.storage.snapshots,
				);
			}) as never,
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
			permission: "content:read",
			handler: (async (
				routeCtx: { input: unknown; user?: unknown },
				ctx: {
					content?: { get?: (collection: string, id: string) => Promise<unknown> };
					storage: Record<string, unknown>;
				},
			) => {
				if (!ctx.content?.get) throw new Error("CONTENT_READ_REQUIRED");
				return persistRecord(routeCtx.input, "proposal", routeCtx.user, ctx as never);
			}),
		},
		ingestExperiment: {
			permission: "content:read",
			handler: (async (
				routeCtx: { input: unknown; user?: unknown },
				ctx: {
					content?: { get?: (collection: string, id: string) => Promise<unknown> };
					storage: Record<string, unknown>;
				},
			) => {
				if (!ctx.content?.get) throw new Error("CONTENT_READ_REQUIRED");
				return persistRecord(routeCtx.input, "experiment", routeCtx.user, ctx as never);
			}),
		},
		recent: {
			permission: "plugins:manage",
			handler: (async (
				routeCtx: { input: unknown },
				ctx: {
					content: { get: (collection: string, id: string) => Promise<unknown> };
					storage: {
						snapshots: { get: (id: string) => Promise<unknown> };
						proposals: {
							query: (
								options: unknown,
							) => Promise<{ items: unknown[]; cursor?: string; hasMore?: boolean }>;
						};
						experiments: {
							query: (
								options: unknown,
							) => Promise<{ items: unknown[]; cursor?: string; hasMore?: boolean }>;
						};
					};
				},
			) => {
				const listInput = routeCtx.input === undefined ? {} : routeCtx.input;
				if (!strictRecord(listInput, ["limit", "cursor"]))
					throw new Error("RECORD_LIST_INPUT_INVALID");
				const limit = listInput.limit === undefined ? 20 : (listInput.limit as number);
				if (
					!Number.isSafeInteger(limit) ||
					limit < 1 ||
					limit > 50 ||
					(listInput.cursor !== undefined &&
						(!strictRecord(listInput.cursor, ["proposals", "experiments"]) ||
							(listInput.cursor.proposals !== undefined &&
								!boundedText(listInput.cursor.proposals, 256)) ||
							(listInput.cursor.experiments !== undefined &&
								!boundedText(listInput.cursor.experiments, 256))))
				)
					throw new Error("RECORD_LIST_INPUT_INVALID");
				const [proposals, experiments] = await Promise.all([
					ctx.storage.proposals
						.query({
							limit: limit + 1,
							cursor: listInput.cursor?.proposals,
							orderBy: { updatedAt: "desc", id: "asc" },
						})
						.catch(() => {
							throw new Error("RECORD_LIST_STORAGE_READ_FAILED");
						}),
					ctx.storage.experiments
						.query({
							limit: limit + 1,
							cursor: listInput.cursor?.experiments,
							orderBy: { updatedAt: "desc", id: "asc" },
						})
						.catch(() => {
							throw new Error("RECORD_LIST_STORAGE_READ_FAILED");
						}),
				]);
				const project = async (
					items: unknown[],
					kind: "proposal" | "experiment",
				): Promise<Record<string, unknown>[]> => {
					const output: Record<string, unknown>[] = [];
					for (const item of items) {
						const value = projectRecord(plain(item) && "data" in item ? item.data : item, kind);
						const content = value.content as Record<string, unknown>;
						const current = await ctx.content
							.get(String(content.collection), String(content.id))
							.catch(() => {
								throw new Error("RECORD_CONTENT_READ_FAILED");
							});
						if (
							!plain(current) ||
							current.status !== "published" ||
							current.locale !== value.locale ||
							current.type !== COLLECTION_TYPE[String(content.collection)] ||
							current.slug !== String(content.path).split("/").pop()
						)
							continue;
						const snapshot = readStoredSnapshot(
							await ctx.storage.snapshots
								.get(String((value.evidence as Record<string, unknown>).snapshotId))
								.catch(() => {
									throw new Error("RECORD_EVIDENCE_READ_FAILED");
								}),
						);
						const ev = value.evidence as Record<string, unknown>;
						if (
							snapshot.digest !== ev.digest ||
							snapshot.targetKey !== value.targetKey ||
							snapshot.target.contentId !== content.id ||
							snapshot.target.path !== content.path ||
							snapshot.locale !== value.locale ||
							snapshot.source !== ev.source ||
							snapshot.formulaVersion !== ev.formulaVersion ||
							canonicalJson(snapshot.window) !== canonicalJson(ev.window)
						)
							continue;
						const stale =
							Date.now() - Date.parse(snapshot.freshness.observedAt) >
							snapshot.freshness.maxAgeSeconds * 1000;
						value.evidence = {
							...ev,
							freshness: snapshot.freshness,
							uncertainty: [...snapshot.sampleWarnings, ...(stale ? ["stale"] : [])],
						};
						output.push(value);
					}
					return output;
				};
				const [proposalItems, experimentItems] = await Promise.all([
					project(proposals.items, "proposal"),
					project(experiments.items, "experiment"),
				]);
				return {
					snapshots: [],
					proposals: proposalItems.slice(0, limit),
					experiments: experimentItems.slice(0, limit),
					nextCursor: { proposals: proposals.cursor, experiments: experiments.cursor },
					hasMore:
						proposalItems.length > limit ||
						experimentItems.length > limit ||
						Boolean(proposals.hasMore || experiments.hasMore),
				};
			}) as never,
		},
		recordDetail: {
			permission: "plugins:manage",
			handler: (async (
				routeCtx: { input: unknown },
				ctx: {
					content: { get: (collection: string, id: string) => Promise<unknown> };
					storage: {
						proposals: { get: (id: string) => Promise<unknown> };
						experiments: { get: (id: string) => Promise<unknown> };
						snapshots: { get: (id: string) => Promise<unknown> };
					};
				},
			) => {
				if (
					!strictRecord(routeCtx.input, ["kind", "id"]) ||
					!["proposal", "experiment"].includes(String(routeCtx.input.kind)) ||
					!boundedText(routeCtx.input.id, 128) ||
					!TEXT_ID.test(String(routeCtx.input.id))
				)
					throw new Error("RECORD_DETAIL_INPUT_INVALID");
				const store =
					routeCtx.input.kind === "proposal" ? ctx.storage.proposals : ctx.storage.experiments;
				const raw = await store.get(String(routeCtx.input.id)).catch(() => {
					throw new Error("RECORD_STORAGE_READ_FAILED");
				});
				if (raw === null) throw new Error("RECORD_NOT_FOUND");
				const value = projectRecord(
					plain(raw) && "data" in raw ? raw.data : raw,
					routeCtx.input.kind as "proposal" | "experiment",
				);
				const content = value.content as Record<string, unknown>;
				const current = await ctx.content
					.get(String(content.collection), String(content.id))
					.catch(() => {
						throw new Error("RECORD_CONTENT_READ_FAILED");
					});
				if (
					!plain(current) ||
					current.status !== "published" ||
					current.id !== content.id ||
					current.locale !== value.locale ||
					current.type !== COLLECTION_TYPE[String(content.collection)] ||
					current.slug !== String(content.path).split("/").pop()
				)
					throw new Error("RECORD_REFERENCE_STALE");
				const ev = value.evidence as Record<string, unknown>;
				const snapshot = readStoredSnapshot(
					await ctx.storage.snapshots.get(String(ev.snapshotId)).catch(() => {
						throw new Error("RECORD_EVIDENCE_READ_FAILED");
					}),
				);
				if (
					snapshot.digest !== ev.digest ||
					snapshot.targetKey !== value.targetKey ||
					snapshot.target.contentId !== content.id ||
					snapshot.target.path !== content.path ||
					snapshot.locale !== value.locale ||
					snapshot.source !== ev.source ||
					snapshot.formulaVersion !== ev.formulaVersion ||
					canonicalJson(snapshot.window) !== canonicalJson(ev.window)
				)
					throw new Error("RECORD_REFERENCE_STALE");
				const stale =
					Date.now() - Date.parse(snapshot.freshness.observedAt) >
					snapshot.freshness.maxAgeSeconds * 1000;
				value.evidence = {
					...ev,
					freshness: snapshot.freshness,
					uncertainty: [...snapshot.sampleWarnings, ...(stale ? ["stale"] : [])],
				};
				return value;
			}) as never,
		},
	},
} satisfies SandboxedPlugin;
