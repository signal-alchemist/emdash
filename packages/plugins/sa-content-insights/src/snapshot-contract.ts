import {
	validateMetricSnapshot,
	type MetricSnapshot,
} from "@signal-alchemist/marketing-automation-contracts";

export const SNAPSHOT_SOURCES = [
	"gsc",
	"ga4",
	"first_party_funnel",
	"experiment",
	"crm_revenue",
] as const;
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];
export type SnapshotEnvelope = {
	version: 1;
	collection: string;
	locale: string;
	source: SnapshotSource;
	formulaVersion: string;
	importedAt: string;
	freshness: { observedAt: string; maxAgeSeconds: number };
	snapshot: MetricSnapshot;
};

const COLLECTION = /^[a-z][a-z0-9_-]{0,62}$/u;
const LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;
const TEXT = /^[\x20-\x7e]+$/u;
const SOURCE_FORMULA: Record<SnapshotSource, string> = {
	gsc: "gsc-search-analytics-v1",
	ga4: "ga4-analytics-v1",
	first_party_funnel: "first-party-funnel-v1",
	experiment: "experiment-result-v1",
	crm_revenue: "crm-revenue-v1",
};
const MAX_DEFINITIONS = 100;
const MAX_MAP_ENTRIES = 100;
const MAX_WARNINGS = 100;
const MAX_SERIALIZED_BYTES = 16_384;
const MAX_AGE_SECONDS = 31_536_000;
const SAFE_METRIC_ID = /^[a-z][a-z0-9_.-]{0,63}$/u;
const SAFE_WARNING = /^(LOW_SAMPLE|PARTIAL_WINDOW|BOT_FILTERED|TRACKING_GAP)$/u;
const UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CURRENCY = /^[A-Z]{3}$/u;

type SourceAggregateBase = {
	version: 1;
	snapshotId: string;
	contentId: string;
	path: string;
	from: string;
	to: string;
	generatedAt: string;
};
export type GscAggregateRow = SourceAggregateBase & { impressions: number; clicks: number };
export type Ga4AggregateRow = SourceAggregateBase & {
	sessions: number;
	pageViews: number;
	conversions: number;
};
export type FirstPartyAggregateRow = SourceAggregateBase & {
	sessions: number;
	pageViews: number;
	ctaExposures: number;
	ctaClicks: number;
	formStarts: number;
	conversions: number;
};
export type ExperimentAggregateRow = SourceAggregateBase & {
	exposures: number;
	conversions: number;
};
export type CrmRevenueAggregateRow = SourceAggregateBase & {
	qualifiedSessions: number;
	conversions: number;
	revenueMinor: number;
	currency: string;
};
export type SourceAggregateRow =
	| GscAggregateRow
	| Ga4AggregateRow
	| FirstPartyAggregateRow
	| ExperimentAggregateRow
	| CrmRevenueAggregateRow;

function count(value: unknown, code: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > 9_000_000_000_000_000
	)
		fail(code);
	return value;
}

function rowBase(row: SourceAggregateRow, keys: readonly string[]): MetricSnapshot {
	if (!plain(row)) fail("SOURCE_ROW_INVALID");
	exact(
		row,
		["version", "snapshotId", "contentId", "path", "from", "to", "generatedAt", ...keys],
		"SOURCE_ROW",
	);
	if (row.version !== 1) fail("SOURCE_ROW_VERSION_INVALID");
	const raw = row as unknown as Record<string, unknown>;
	for (const key of ["snapshotId", "contentId", "path", "from", "to", "generatedAt"])
		if (typeof raw[key] !== "string" || raw[key].length === 0 || raw[key].length > 256)
			fail("SOURCE_ROW_INVALID");
	iso(raw.from, "SOURCE_ROW_TIME_INVALID");
	iso(raw.to, "SOURCE_ROW_TIME_INVALID");
	iso(raw.generatedAt, "SOURCE_ROW_TIME_INVALID");
	return {
		version: 1,
		snapshotId: raw.snapshotId as string,
		target: { kind: "content", contentId: raw.contentId as string, path: raw.path as string },
		window: { from: raw.from as string, to: raw.to as string },
		definitions: [],
		funnel: {
			sessions: 0,
			pageViews: 0,
			ctaExposures: 0,
			ctaClicks: 0,
			formStarts: 0,
			conversions: 0,
		},
		custom: {},
		sampleWarnings: [],
		generatedAt: raw.generatedAt as string,
	};
}

export function adaptGscRow(row: GscAggregateRow): MetricSnapshot {
	const base = rowBase(row, ["impressions", "clicks"]);
	base.funnel.impressions = count(row.impressions, "SOURCE_ROW_INVALID");
	base.funnel.clicks = count(row.clicks, "SOURCE_ROW_INVALID");
	base.funnel.sessions = count(row.clicks, "SOURCE_ROW_INVALID");
	base.funnel.pageViews = count(row.clicks, "SOURCE_ROW_INVALID");
	base.definitions = [
		{ id: "impressions", label: "Impressions", unit: "count", source: sourceFormula("gsc") },
		{ id: "clicks", label: "Clicks", unit: "count", source: sourceFormula("gsc") },
		{
			id: "ctr",
			label: "Click rate",
			numerator: "clicks",
			denominator: "impressions",
			unit: "ratio",
			source: sourceFormula("gsc"),
		},
	];
	base.custom = {
		ctr: base.funnel.impressions ? base.funnel.clicks / base.funnel.impressions : null,
	};
	return base;
}
export function adaptGa4Row(row: Ga4AggregateRow): MetricSnapshot {
	const base = rowBase(row, ["sessions", "pageViews", "conversions"]);
	base.funnel.sessions = count(row.sessions, "SOURCE_ROW_INVALID");
	base.funnel.pageViews = count(row.pageViews, "SOURCE_ROW_INVALID");
	base.funnel.conversions = count(row.conversions, "SOURCE_ROW_INVALID");
	base.definitions = [
		{ id: "sessions", label: "Sessions", unit: "count", source: sourceFormula("ga4") },
		{ id: "conversions", label: "Conversions", unit: "count", source: sourceFormula("ga4") },
		{
			id: "conversionrate",
			label: "Conversion rate",
			numerator: "conversions",
			denominator: "sessions",
			unit: "ratio",
			source: sourceFormula("ga4"),
		},
	];
	base.custom = {
		conversionrate: base.funnel.sessions ? base.funnel.conversions / base.funnel.sessions : null,
	};
	return base;
}
export function adaptFirstPartyFunnelRow(row: FirstPartyAggregateRow): MetricSnapshot {
	const base = rowBase(row, [
		"sessions",
		"pageViews",
		"ctaExposures",
		"ctaClicks",
		"formStarts",
		"conversions",
	]);
	base.funnel.sessions = count(row.sessions, "SOURCE_ROW_INVALID");
	base.funnel.pageViews = count(row.pageViews, "SOURCE_ROW_INVALID");
	base.funnel.ctaExposures = count(
		row.ctaExposures,
		"SOURCE_ROW_INVALID",
	);
	base.funnel.ctaClicks = count(row.ctaClicks, "SOURCE_ROW_INVALID");
	base.funnel.formStarts = count(row.formStarts, "SOURCE_ROW_INVALID");
	base.funnel.conversions = count(
		row.conversions,
		"SOURCE_ROW_INVALID",
	);
	base.definitions = [
		{
			id: "ctaclicks",
			label: "CTA clicks",
			unit: "count",
			source: sourceFormula("first_party_funnel"),
		},
		{
			id: "ctaexposures",
			label: "CTA exposures",
			unit: "count",
			source: sourceFormula("first_party_funnel"),
		},
		{
			id: "ctr",
			label: "CTA rate",
			numerator: "ctaclicks",
			denominator: "ctaexposures",
			unit: "ratio",
			source: sourceFormula("first_party_funnel"),
		},
	];
	base.custom = {
		ctr: base.funnel.ctaExposures ? base.funnel.ctaClicks / base.funnel.ctaExposures : null,
	};
	return base;
}
export function adaptExperimentRow(row: ExperimentAggregateRow): MetricSnapshot {
	const base = rowBase(row, ["exposures", "conversions"]);
	base.funnel.sessions = count(row.exposures, "SOURCE_ROW_INVALID");
	base.funnel.pageViews = base.funnel.sessions;
	base.funnel.conversions = count(
		row.conversions,
		"SOURCE_ROW_INVALID",
	);
	base.definitions = [
		{ id: "exposures", label: "Exposures", unit: "count", source: sourceFormula("experiment") },
		{ id: "conversions", label: "Conversions", unit: "count", source: sourceFormula("experiment") },
		{
			id: "conversionrate",
			label: "Conversion rate",
			numerator: "conversions",
			denominator: "exposures",
			unit: "ratio",
			source: sourceFormula("experiment"),
		},
	];
	base.custom = {
		conversionrate: base.funnel.sessions ? base.funnel.conversions / base.funnel.sessions : null,
	};
	return base;
}
export function adaptCrmRevenueRow(row: CrmRevenueAggregateRow): MetricSnapshot {
	const base = rowBase(row, [
		"qualifiedSessions",
		"conversions",
		"revenueMinor",
		"currency",
	]);
	base.funnel.sessions = count(
		row.qualifiedSessions,
		"SOURCE_ROW_INVALID",
	);
	base.funnel.pageViews = base.funnel.sessions;
	base.funnel.conversions = count(
		row.conversions,
		"SOURCE_ROW_INVALID",
	);
	base.funnel.revenueMinor = count(
		row.revenueMinor,
		"SOURCE_ROW_INVALID",
	);
	if (
		typeof row.currency !== "string" ||
		!CURRENCY.test(row.currency)
	)
		fail("SOURCE_ROW_INVALID");
	base.funnel.currency = row.currency;
	base.definitions = [
		{ id: "revenue", label: "Revenue", unit: "currency", source: sourceFormula("crm_revenue") },
	];
	base.custom = {};
	return base;
}
export function adaptSourceRow(source: SnapshotSource, row: SourceAggregateRow): MetricSnapshot {
	switch (source) {
		case "gsc":
			return adaptGscRow(row as GscAggregateRow);
		case "ga4":
			return adaptGa4Row(row as Ga4AggregateRow);
		case "first_party_funnel":
			return adaptFirstPartyFunnelRow(row as FirstPartyAggregateRow);
		case "experiment":
			return adaptExperimentRow(row as ExperimentAggregateRow);
		case "crm_revenue":
			return adaptCrmRevenueRow(row as CrmRevenueAggregateRow);
	}
}

function fail(code: string): never {
	throw new Error(code);
}

function plain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
	const allowed = new Set(keys);
	if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${code}_EXCESS`);
	if (keys.some((key) => !(key in value))) fail(`${code}_MISSING`);
}

function iso(value: unknown, code: string): string {
	if (
		typeof value !== "string" ||
		!UTC_RFC3339.test(value) ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	)
		fail(code);
	return value;
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (plain(value))
		return Object.fromEntries(sortKeys(Object.keys(value)).map((key) => [key, stable(value[key])]));
	return value;
}

function sortKeys(keys: string[]): string[] {
	if (keys.length < 2) return keys.slice();
	const middle = Math.floor(keys.length / 2);
	const left = sortKeys(keys.slice(0, middle));
	const right = sortKeys(keys.slice(middle));
	const output: string[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length || j < right.length) {
		if (j >= right.length || (i < left.length && left[i] <= right[j])) output.push(left[i++]);
		else output.push(right[j++]);
	}
	return output;
}

export function sourceFormula(source: SnapshotSource): string {
	return SOURCE_FORMULA[source];
}

export function normalizeSnapshotEnvelope(input: unknown): SnapshotEnvelope {
	if (!plain(input)) fail("SNAPSHOT_ENVELOPE_INVALID");
	exact(
		input,
		[
			"version",
			"collection",
			"locale",
			"source",
			"formulaVersion",
			"importedAt",
			"freshness",
			"snapshot",
		],
		"SNAPSHOT_ENVELOPE",
	);
	if (input.version !== 1) fail("SNAPSHOT_VERSION_INVALID");
	if (typeof input.collection !== "string" || !COLLECTION.test(input.collection))
		fail("SNAPSHOT_COLLECTION_INVALID");
	if (
		typeof input.locale !== "string" ||
		!LOCALE.test(input.locale) ||
		input.locale !== input.locale.toLowerCase()
	)
		fail("SNAPSHOT_LOCALE_INVALID");
	if (
		typeof input.source !== "string" ||
		!(SNAPSHOT_SOURCES as readonly string[]).includes(input.source)
	)
		fail("SNAPSHOT_SOURCE_INVALID");
	const source = input.source as SnapshotSource;
	if (input.formulaVersion !== SOURCE_FORMULA[source]) fail("SNAPSHOT_FORMULA_INVALID");
	const importedAt = iso(input.importedAt, "SNAPSHOT_IMPORTED_AT_INVALID");
	if (!plain(input.freshness)) fail("SNAPSHOT_FRESHNESS_INVALID");
	exact(input.freshness, ["observedAt", "maxAgeSeconds"], "SNAPSHOT_FRESHNESS");
	const observedAt = iso(input.freshness.observedAt, "SNAPSHOT_OBSERVED_AT_INVALID");
	if (
		typeof input.freshness.maxAgeSeconds !== "number" ||
		!Number.isSafeInteger(input.freshness.maxAgeSeconds) ||
		input.freshness.maxAgeSeconds < 0 ||
		input.freshness.maxAgeSeconds > MAX_AGE_SECONDS
	)
		fail("SNAPSHOT_MAX_AGE_INVALID");
	if (
		Date.parse(importedAt) < Date.parse(observedAt) ||
		Date.parse(importedAt) - Date.parse(observedAt) > input.freshness.maxAgeSeconds * 1000
	)
		fail("SNAPSHOT_FRESHNESS_EXPIRED");
	const snapshot = validateMetricSnapshot(input.snapshot);
	if (snapshot.target.kind !== "content") fail("SNAPSHOT_TARGET_CONTENT_REQUIRED");
	iso(snapshot.window.from, "SNAPSHOT_WINDOW_FROM_INVALID");
	iso(snapshot.window.to, "SNAPSHOT_WINDOW_TO_INVALID");
	iso(snapshot.generatedAt, "SNAPSHOT_GENERATED_AT_INVALID");
	if (Date.parse(snapshot.window.from) >= Date.parse(snapshot.window.to))
		fail("SNAPSHOT_WINDOW_INVALID");
	if (Date.parse(observedAt) < Date.parse(snapshot.generatedAt))
		fail("SNAPSHOT_OBSERVED_AT_INVALID");
	if (
		snapshot.definitions.length > MAX_DEFINITIONS ||
		snapshot.sampleWarnings.length > MAX_WARNINGS
	)
		fail("SNAPSHOT_BOUNDS_INVALID");
	if (
		Object.keys(snapshot.custom).length > MAX_MAP_ENTRIES ||
		Object.keys(snapshot.funnel.sectionExposures ?? {}).length > MAX_MAP_ENTRIES ||
		Object.keys(snapshot.funnel.scrollDepth ?? {}).length > MAX_MAP_ENTRIES
	)
		fail("SNAPSHOT_BOUNDS_INVALID");
	const definitionIds = new Set<string>();
	for (const definition of snapshot.definitions) {
		if (
			!SAFE_METRIC_ID.test(definition.id) ||
			!TEXT.test(definition.label) ||
			definition.label.length > 128 ||
			definitionIds.has(definition.id) ||
			definition.source !== input.formulaVersion
		)
			fail("SNAPSHOT_DEFINITION_INVALID");
		definitionIds.add(definition.id);
		if (definition.unit === "ratio") {
			if (
				!definition.numerator ||
				!definition.denominator ||
				definition.numerator === definition.denominator
			)
				fail("SNAPSHOT_DEFINITION_REFERENCE_INVALID");
			if (
				definition.numerator &&
				definition.denominator &&
				(snapshot.definitions.find((candidate) => candidate.id === definition.numerator)?.unit !==
					"count" ||
					snapshot.definitions.find((candidate) => candidate.id === definition.denominator)
						?.unit !== "count")
			)
				fail("SNAPSHOT_DEFINITION_REFERENCE_INVALID");
		}
		if (
			definition.unit === "currency" &&
			(snapshot.funnel.revenueMinor === undefined || !snapshot.funnel.currency)
		)
			fail("SNAPSHOT_CURRENCY_INVALID");
	}
	for (const definition of snapshot.definitions) {
		for (const reference of [definition.numerator, definition.denominator])
			if (reference && !definitionIds.has(reference)) fail("SNAPSHOT_DEFINITION_REFERENCE_INVALID");
	}
	if (
		snapshot.funnel.impressions !== undefined &&
		snapshot.funnel.clicks !== undefined &&
		snapshot.funnel.clicks > snapshot.funnel.impressions
	)
		fail("SNAPSHOT_FUNNEL_INCONSISTENT");
	if (
		snapshot.funnel.ctaClicks > snapshot.funnel.ctaExposures ||
		snapshot.funnel.conversions > snapshot.funnel.sessions ||
		(source === "first_party_funnel" && snapshot.funnel.conversions > snapshot.funnel.formStarts)
	)
		fail("SNAPSHOT_FUNNEL_INCONSISTENT");
	for (const warning of snapshot.sampleWarnings)
		if (!SAFE_WARNING.test(warning)) fail("SNAPSHOT_WARNING_INVALID");
	const definitionsById = new Map(
		snapshot.definitions.map((definition) => [definition.id, definition]),
	);
	for (const [key, value] of Object.entries(snapshot.custom)) {
		if (!SAFE_METRIC_ID.test(key) || !definitionsById.has(key)) fail("SNAPSHOT_CUSTOM_KEY_INVALID");
		if (value !== null && (typeof value !== "number" || !Number.isFinite(value)))
			fail("SNAPSHOT_CUSTOM_VALUE_INVALID");
		const definition = definitionsById.get(key)!;
		if (
			value !== null &&
			(definition.unit === "count" || definition.unit === "currency") &&
			(!Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000_000)
		)
			fail("SNAPSHOT_CUSTOM_VALUE_INVALID");
		if (
			value !== null &&
			(definition.unit === "duration" || definition.unit === "position") &&
			(value < 0 || value > 9_000_000_000_000_000)
		)
			fail("SNAPSHOT_CUSTOM_VALUE_INVALID");
		if (definition.unit === "ratio" && value !== null) {
			if (value < 0 || value > 1) fail("SNAPSHOT_RATIO_INVALID");
			const denominator = definition.denominator
				? funnelMetric(snapshot.funnel, definition.denominator)
				: undefined;
			const numerator = definition.numerator
				? funnelMetric(snapshot.funnel, definition.numerator)
				: undefined;
			if (
				denominator === undefined ||
				numerator === undefined ||
				denominator <= 0 ||
				Math.abs(value - numerator / denominator) > 1e-9
			)
				fail("SNAPSHOT_RATIO_INVALID");
		}
	}
	if (
		(snapshot.funnel.revenueMinor === undefined) !== (snapshot.funnel.currency === undefined) ||
		(snapshot.funnel.currency !== undefined && !CURRENCY.test(snapshot.funnel.currency))
	)
		fail("SNAPSHOT_CURRENCY_INVALID");
	if (snapshot.funnel.revenueMinor !== undefined)
		count(snapshot.funnel.revenueMinor, "SNAPSHOT_CURRENCY_INVALID");
	if (
		snapshot.funnel.impressions !== undefined &&
		snapshot.funnel.clicks !== undefined &&
		snapshot.funnel.clicks > snapshot.funnel.impressions
	)
		fail("SNAPSHOT_FUNNEL_INCONSISTENT");
	if (
		snapshot.funnel.ctaClicks > snapshot.funnel.ctaExposures ||
		snapshot.funnel.conversions > snapshot.funnel.sessions ||
		(source === "first_party_funnel" && snapshot.funnel.conversions > snapshot.funnel.formStarts)
	)
		fail("SNAPSHOT_FUNNEL_INCONSISTENT");
	if (Date.parse(snapshot.generatedAt) < Date.parse(snapshot.window.to))
		fail("SNAPSHOT_GENERATED_AT_INVALID");
	if (
		Object.keys(snapshot.custom).length > MAX_MAP_ENTRIES ||
		Object.keys(snapshot.funnel.sectionExposures ?? {}).length > MAX_MAP_ENTRIES ||
		Object.keys(snapshot.funnel.scrollDepth ?? {}).length > MAX_MAP_ENTRIES
	)
		fail("SNAPSHOT_BOUNDS_INVALID");
	const normalized: SnapshotEnvelope = {
		version: 1,
		collection: input.collection,
		locale: input.locale,
		source,
		formulaVersion: input.formulaVersion,
		importedAt,
		freshness: { observedAt, maxAgeSeconds: input.freshness.maxAgeSeconds },
		snapshot,
	};
	if (
		new TextEncoder().encode(JSON.stringify(stable(normalized))).byteLength > MAX_SERIALIZED_BYTES
	)
		fail("SNAPSHOT_SERIALIZED_LIMIT");
	return normalized;
}

function funnelMetric(funnel: MetricSnapshot["funnel"], id: string): number | undefined {
	const aliases: Record<string, string> = {
		ctaclicks: "ctaClicks",
		ctaexposures: "ctaExposures",
		sessions: "sessions",
		pageviews: "pageViews",
		conversions: "conversions",
		formstarts: "formStarts",
		impressions: "impressions",
		clicks: "clicks",
		exposures: "sessions",
	};
	if (!(id in aliases)) return undefined;
	const value = (funnel as unknown as Record<string, unknown>)[aliases[id]];
	return typeof value === "number" ? value : undefined;
}

export function stableEnvelopeJson(envelope: SnapshotEnvelope): string {
	return JSON.stringify(stable(envelope));
}

export const SNAPSHOT_LIMITS = {
	MAX_DEFINITIONS,
	MAX_MAP_ENTRIES,
	MAX_WARNINGS,
	MAX_SERIALIZED_BYTES,
} as const;
