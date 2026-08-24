const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE = /^[a-z][a-z0-9_.-]{0,127}$/u;
const WARNING = /^(LOW_SAMPLE|PARTIAL_WINDOW|BOT_FILTERED|TRACKING_GAP)$/u;
const FUNNEL_KEY = /^[a-z][A-Za-z0-9_.-]{0,63}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SOURCES: Record<string, string> = {
	gsc: "gsc-search-analytics-v1",
	ga4: "ga4-analytics-v1",
	first_party_funnel: "first-party-funnel-v1",
	experiment: "experiment-result-v1",
	crm_revenue: "crm-revenue-v1",
};
const COLLECTION = /^[a-z][a-z0-9_-]{0,62}$/u;
const LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;
const TARGET_PATH = /^\/[a-z][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9-]{0,127}$/u;
const CONTENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;

export type StoredSnapshot = {
	version: number;
	snapshotId: string;
	collection: string;
	locale: string;
	source: string;
	formulaVersion: string;
	targetKey: string;
	target: { kind: "content"; contentId: string; path: string };
	window: { from: string; to: string };
	importedAt: string;
	freshness: { observedAt: string; maxAgeSeconds: number };
	definitions: Array<Record<string, unknown>>;
	funnel: Record<string, unknown>;
	custom: Record<string, unknown>;
	sampleWarnings: string[];
	digest: string;
	generatedAt?: string;
	sourceCommit?: string;
	previousDigest?: string;
};
function plain(v: unknown): v is Record<string, unknown> {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
	);
}
function time(v: unknown): v is string {
	if (typeof v !== "string" || !ISO.test(v) || !Number.isFinite(Date.parse(v))) return false;
	try {
		return new Date(v).toISOString() === v;
	} catch {
		return false;
	}
}
function exact(v: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Error("SUMMARY_STORAGE_CORRUPT");
}
function control(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) return true;
	}
	return false;
}
function copy(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(copy);
	if (plain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
	return v;
}
export function readStoredSnapshot(value: unknown): StoredSnapshot {
	if (!plain(value)) throw new Error("SUMMARY_STORAGE_CORRUPT");
	exact(value, [
		"snapshotId",
		"version",
		"collection",
		"locale",
		"source",
		"formulaVersion",
		"targetKey",
		"target",
		"window",
		"importedAt",
		"freshness",
		"definitions",
		"funnel",
		"custom",
		"sampleWarnings",
		"digest",
		"generatedAt",
		"sourceCommit",
		"previousDigest",
	]);
	for (const k of ["snapshotId", "collection", "locale", "source", "formulaVersion", "targetKey"])
		if (
			typeof value[k] !== "string" ||
			value[k].length === 0 ||
			value[k].length > 256 ||
			control(value[k])
		)
			throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		value.version !== 1 ||
		!plain(value.target) ||
		Object.keys(value.target).some((k) => !["kind", "contentId", "path"].includes(k)) ||
		value.target.kind !== "content" ||
		typeof value.target.contentId !== "string" ||
		typeof value.target.path !== "string" ||
		value.targetKey !== `${value.target.contentId}:${value.target.path}`
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		!Object.hasOwn(SOURCES, value.source as string) ||
		value.formulaVersion !== SOURCES[value.source as string] ||
		!COLLECTION.test(value.collection as string) ||
		!LOCALE.test(value.locale as string) ||
		!TARGET_PATH.test(value.target.path as string) ||
		!CONTENT_ID.test(value.target.contentId as string)
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (!DIGEST.test(String(value.digest)) || !time(value.importedAt) || !time(value.generatedAt))
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		value.sourceCommit !== undefined &&
		(typeof value.sourceCommit !== "string" ||
			value.sourceCommit.length > 256 ||
			control(value.sourceCommit))
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (value.previousDigest !== undefined && !DIGEST.test(String(value.previousDigest)))
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		!plain(value.window) ||
		Object.keys(value.window).some((k) => !["from", "to"].includes(k)) ||
		!time(value.window.from) ||
		!time(value.window.to) ||
		value.window.from >= value.window.to
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		!plain(value.freshness) ||
		Object.keys(value.freshness).some((k) => !["observedAt", "maxAgeSeconds"].includes(k)) ||
		!time(value.freshness.observedAt) ||
		typeof value.freshness.maxAgeSeconds !== "number" ||
		!Number.isSafeInteger(value.freshness.maxAgeSeconds) ||
		value.freshness.maxAgeSeconds < 0 ||
		value.freshness.maxAgeSeconds > 31536000
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		!Array.isArray(value.definitions) ||
		value.definitions.length > 100 ||
		!value.definitions.every(
			(d) =>
				plain(d) &&
				Object.keys(d).every((k) =>
					["id", "label", "unit", "source", "numerator", "denominator"].includes(k),
				) &&
				typeof d.id === "string" &&
				SAFE.test(d.id) &&
				typeof d.label === "string" &&
				d.label.length <= 256 &&
				!control(d.label) &&
				typeof d.source === "string" &&
				d.source === SOURCES[value.source as string] &&
				!control(d.source) &&
				typeof d.unit === "string" &&
				(d.numerator === undefined ||
					(typeof d.numerator === "string" && SAFE.test(d.numerator))) &&
				(d.denominator === undefined ||
					(typeof d.denominator === "string" && SAFE.test(d.denominator))),
		)
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		!plain(value.funnel) ||
		!plain(value.custom) ||
		Object.keys(value.funnel).length > 100 ||
		Object.keys(value.custom).length > 100 ||
		Object.keys(value.custom).some((k) => !SAFE.test(k))
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		Object.entries(value.funnel).some(
			([key, v]) =>
				key !== "currency" &&
				(![
					"impressions",
					"clicks",
					"sessions",
					"pageViews",
					"sectionExposures",
					"scrollDepth",
					"ctaExposures",
					"ctaClicks",
					"formStarts",
					"conversions",
					"exposures",
					"revenueMinor",
				].includes(key) ||
					!FUNNEL_KEY.test(key) ||
					typeof v !== "number" ||
					!Number.isSafeInteger(v) ||
					v < 0),
		) ||
		(value.funnel.currency !== undefined &&
			(typeof value.funnel.currency !== "string" || !CURRENCY.test(value.funnel.currency))) ||
		Object.entries(value.custom).some(
			([key, v]) =>
				!SAFE.test(key) || (v !== null && (typeof v !== "number" || !Number.isFinite(v))),
		)
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	if (
		!Array.isArray(value.sampleWarnings) ||
		value.sampleWarnings.length > 100 ||
		value.sampleWarnings.some((w) => typeof w !== "string" || !WARNING.test(w))
	)
		throw new Error("SUMMARY_STORAGE_CORRUPT");
	return {
		version: 1,
		snapshotId: value.snapshotId as string,
		collection: value.collection as string,
		locale: value.locale as string,
		source: value.source as string,
		formulaVersion: value.formulaVersion as string,
		targetKey: value.targetKey as string,
		target: { kind: "content", contentId: value.target.contentId, path: value.target.path },
		window: { from: value.window.from, to: value.window.to },
		importedAt: value.importedAt,
		freshness: {
			observedAt: value.freshness.observedAt,
			maxAgeSeconds: value.freshness.maxAgeSeconds,
		},
		definitions: copy(value.definitions) as Array<Record<string, unknown>>,
		funnel: copy(value.funnel) as Record<string, unknown>,
		custom: copy(value.custom) as Record<string, unknown>,
		sampleWarnings: [...value.sampleWarnings],
		digest: value.digest as string,
		...(value.generatedAt === undefined ? {} : { generatedAt: value.generatedAt }),
		...(value.sourceCommit === undefined ? {} : { sourceCommit: value.sourceCommit as string }),
		...(value.previousDigest === undefined
			? {}
			: { previousDigest: value.previousDigest as string }),
	};
}
