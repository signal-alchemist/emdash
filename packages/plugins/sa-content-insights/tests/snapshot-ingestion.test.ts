import type { MetricSnapshot } from "@signal-alchemist/marketing-automation-contracts";
import { describe, expect, it, vi } from "vitest";

import { contentInsightsPlugin } from "../src/index.js";
import plugin from "../src/sandbox-entry.js";
import {
	adaptSourceRow,
	normalizeSnapshotEnvelope,
	sourceFormula,
	SNAPSHOT_SOURCES,
} from "../src/snapshot-contract.js";

const snapshot: MetricSnapshot = {
	version: 1,
	snapshotId: "snapshot-001",
	target: { kind: "content", contentId: "content-alpha", path: "/posts/alpha" },
	window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-07T00:00:00.000Z" },
	definitions: [
		{ id: "ctaclicks", label: "CTA clicks", unit: "count", source: "gsc-search-analytics-v1" },
		{
			id: "ctaexposures",
			label: "CTA exposures",
			unit: "count",
			source: "gsc-search-analytics-v1",
		},
		{
			id: "ctr",
			label: "CTA rate",
			numerator: "ctaclicks",
			denominator: "ctaexposures",
			unit: "ratio",
			source: "gsc-search-analytics-v1",
		},
	],
	funnel: {
		sessions: 10,
		pageViews: 10,
		ctaExposures: 5,
		ctaClicks: 2,
		formStarts: 1,
		conversions: 1,
	},
	custom: { ctr: 0.4 },
	sampleWarnings: [],
	generatedAt: "2026-08-08T00:00:00.000Z",
};
const envelope = (overrides: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "posts",
	locale: "en",
	source: "gsc",
	formulaVersion: sourceFormula("gsc"),
	importedAt: "2026-08-09T00:00:00.000Z",
	freshness: { observedAt: "2026-08-08T00:00:00.000Z", maxAgeSeconds: 86_400 },
	snapshot,
	...overrides,
});
const sourceSnapshot = (source: (typeof SNAPSHOT_SOURCES)[number]) => ({
	...snapshot,
	definitions: snapshot.definitions.map((definition) => ({
		...definition,
		source: sourceFormula(source),
	})),
});

function content(): Record<string, unknown> {
	const item: Record<string, unknown> = {
		id: "content-alpha",
		status: "published",
		locale: "en",
		type: "post",
		slug: "alpha",
	};
	Object.defineProperties(item, {
		data: {
			get: () => {
				throw new Error("body must not be read");
			},
		},
		body: {
			get: () => {
				throw new Error("body must not be read");
			},
		},
	});
	return item;
}

function context(
	options: {
		item?: unknown;
		existing?: Record<string, unknown> | null;
		count?: number;
		getError?: boolean;
		queryError?: boolean;
		badQuery?: boolean;
		putError?: boolean;
	} = {},
) {
	const records = new Map<string, Record<string, unknown>>();
	if (options.existing)
		records.set(String(options.existing.snapshotId ?? "snapshot-001"), options.existing);
	const put = vi.fn(async (id: string, value: Record<string, unknown>) => {
		if (options.putError) throw new Error("write");
		records.set(id, value);
	});
	const get = vi.fn(async (id: string) => {
		if (options.getError) throw new Error("read");
		return records.get(id) ?? null;
	});
	const query = vi.fn(async () => {
		if (options.queryError) throw new Error("query");
		if (options.badQuery) return null as never;
		return {
			items: Array.from({ length: options.count ?? records.size }, (_, index) => ({
				id: `existing-${index}`,
			})),
		};
	});
	return {
		ctx: {
			content: { get: vi.fn(async () => options.item ?? content()) },
			storage: {
				snapshots: { get, query, put },
				proposals: { put: vi.fn(), query: vi.fn(async () => ({ items: [] })) },
				experiments: { put: vi.fn(), query: vi.fn(async () => ({ items: [] })) },
			},
		},
		put,
		get,
		query,
	};
}

const ingest = (
	plugin as unknown as {
		routes: { ingestSnapshot: { handler: (route: unknown, ctx: unknown) => Promise<unknown> } };
	}
).routes.ingestSnapshot.handler;
const stored = (put: ReturnType<typeof vi.fn>) => put.mock.calls[0]?.[1] as Record<string, unknown>;

describe("content insights snapshot ingestion", () => {
	it("declares content read only", () =>
		expect(contentInsightsPlugin().capabilities).toEqual(["content:read"]));
	it("has no network hosts or write capabilities", () =>
		expect(contentInsightsPlugin()).toMatchObject({
			allowedHosts: [],
			capabilities: ["content:read"],
		}));
	it("normalizes every supported source vocabulary", () => {
		for (const source of SNAPSHOT_SOURCES)
			expect(
				normalizeSnapshotEnvelope(
					envelope({
						source,
						formulaVersion: sourceFormula(source),
						snapshot: sourceSnapshot(source),
					}),
				),
			).toMatchObject({ source, formulaVersion: sourceFormula(source) });
	});
	it("uses the public contracts package validator", () =>
		expect(normalizeSnapshotEnvelope(envelope()).snapshot.snapshotId).toBe("snapshot-001"));
	it("accepts the real published ContentItem shape without reading body", async () => {
		const c = context();
		const result = await ingest({ input: envelope() }, c.ctx);
		expect(result).toMatchObject({ accepted: true, snapshotId: "snapshot-001" });
		expect(c.put).toHaveBeenCalledOnce();
		expect(stored(c.put)).not.toHaveProperty("body");
		expect(stored(c.put)).not.toHaveProperty("data");
	});
	it("looks up the requested collection and content id", async () => {
		const c = context();
		await ingest({ input: envelope() }, c.ctx);
		expect(c.ctx.content.get).toHaveBeenCalledWith("posts", "content-alpha");
	});
	it("stores explicit envelope fields and digest", async () => {
		const c = context();
		await ingest({ input: envelope() }, c.ctx);
		expect(stored(c.put)).toMatchObject({
			collection: "posts",
			locale: "en",
			source: "gsc",
			formulaVersion: "gsc-search-analytics-v1",
			importedAt: "2026-08-09T00:00:00.000Z",
			targetKey: "content-alpha:/posts/alpha",
		});
		expect(stored(c.put).digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		expect(stored(c.put)).not.toHaveProperty("visitorId");
		expect(stored(c.put)).not.toHaveProperty("rawEvent");
		expect(stored(c.put)).not.toHaveProperty("credential");
	});
	it("skips an exact duplicate without put", async () => {
		const c = context();
		await ingest({ input: envelope() }, c.ctx);
		c.put.mockClear();
		const result = await ingest({ input: envelope() }, c.ctx);
		expect(result).toMatchObject({ accepted: false, status: "skipped" });
		expect(c.put).not.toHaveBeenCalled();
	});
	it("replaces a compatible newer snapshot with previousDigest", async () => {
		const c = context();
		await ingest({ input: envelope() }, c.ctx);
		c.put.mockClear();
		const later = envelope({
			importedAt: "2026-08-10T00:00:00.000Z",
			freshness: { observedAt: "2026-08-09T00:00:00.000Z", maxAgeSeconds: 86_400 },
			snapshot: {
				...snapshot,
				custom: { ctr: 0.2 },
				funnel: { ...snapshot.funnel, ctaClicks: 1 },
				generatedAt: "2026-08-09T00:00:00.000Z",
			},
		});
		const result = await ingest({ input: later }, c.ctx);
		expect(result).toMatchObject({ accepted: true, replaced: true });
		expect(c.put).toHaveBeenCalledOnce();
		expect(stored(c.put).previousDigest).toMatch(/^sha256:/u);
	});
	it("rejects immutable identity changes", async () => {
		const c = context();
		await ingest({ input: envelope() }, c.ctx);
		await expect(
			ingest(
				{
					input: envelope({
						source: "ga4",
						formulaVersion: sourceFormula("ga4"),
						snapshot: sourceSnapshot("ga4"),
					}),
				},
				c.ctx,
			),
		).rejects.toThrow("SNAPSHOT_CONFLICT");
	});
	it("rejects same identity without newer timestamps", async () => {
		const c = context();
		await ingest({ input: envelope() }, c.ctx);
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: {
							...snapshot,
							custom: { ctr: 0.2 },
							funnel: { ...snapshot.funnel, ctaClicks: 1 },
						},
					}),
				},
				c.ctx,
			),
		).rejects.toThrow("SNAPSHOT_CONFLICT");
	});
	it("rejects missing content capability", async () => {
		const c = context();
		delete (c.ctx as { content?: unknown }).content;
		await expect(ingest({ input: envelope() }, c.ctx)).rejects.toThrow("CONTENT_READ_REQUIRED");
	});
	it("rejects drafts", async () =>
		await expect(
			ingest({ input: envelope() }, context({ item: { ...content(), status: "draft" } }).ctx),
		).rejects.toThrow("SNAPSHOT_CONTENT_NOT_PUBLISHED"));
	it("rejects scheduled and unknown content types", async () => {
		await expect(
			ingest({ input: envelope() }, context({ item: { ...content(), status: "scheduled" } }).ctx),
		).rejects.toThrow("SNAPSHOT_CONTENT_NOT_PUBLISHED");
		await expect(
			ingest({ input: envelope() }, context({ item: { ...content(), type: "article" } }).ctx),
		).rejects.toThrow("SNAPSHOT_CONTENT_TYPE_INVALID");
	});
	it("reports content read failures with a stable code", async () => {
		const c = context();
		c.ctx.content.get = vi.fn(async () => {
			throw new Error("provider credential leaked");
		});
		await expect(ingest({ input: envelope() }, c.ctx)).rejects.toThrow(
			"SNAPSHOT_CONTENT_READ_FAILED",
		);
	});
	it("rejects content id mismatch", async () =>
		await expect(
			ingest({ input: envelope() }, context({ item: { ...content(), id: "other" } }).ctx),
		).rejects.toThrow("SNAPSHOT_CONTENT_ID_MISMATCH"));
	it("rejects locale mismatch", async () =>
		await expect(
			ingest({ input: envelope() }, context({ item: { ...content(), locale: "fr" } }).ctx),
		).rejects.toThrow("SNAPSHOT_CONTENT_LOCALE_MISMATCH"));
	it("rejects slug/path mismatch", async () =>
		await expect(
			ingest({ input: envelope() }, context({ item: { ...content(), slug: "other" } }).ctx),
		).rejects.toThrow("SNAPSHOT_CONTENT_PATH_MISMATCH"));
	it("rejects invalid content type", async () =>
		await expect(
			ingest({ input: envelope() }, context({ item: { ...content(), type: "" } }).ctx),
		).rejects.toThrow("SNAPSHOT_CONTENT_TYPE_INVALID"));
	it("rejects envelope excess and custom prototypes", async () => {
		await expect(ingest({ input: { ...envelope(), extra: true } }, context().ctx)).rejects.toThrow(
			"SNAPSHOT_ENVELOPE_EXCESS",
		);
		const bad = Object.create({ source: "gsc" });
		Object.assign(bad, envelope());
		await expect(ingest({ input: bad }, context().ctx)).rejects.toThrow(
			"SNAPSHOT_ENVELOPE_INVALID",
		);
	});
	it("rejects invalid source and formula", async () => {
		await expect(ingest({ input: envelope({ source: "other" }) }, context().ctx)).rejects.toThrow(
			"SNAPSHOT_SOURCE_INVALID",
		);
		await expect(
			ingest({ input: envelope({ formulaVersion: "gsc-search-analytics-v2" }) }, context().ctx),
		).rejects.toThrow("SNAPSHOT_FORMULA_INVALID");
	});
	it("rejects invalid locale and freshness", async () => {
		await expect(ingest({ input: envelope({ locale: "EN" }) }, context().ctx)).rejects.toThrow(
			"SNAPSHOT_LOCALE_INVALID",
		);
		await expect(
			ingest(
				{
					input: envelope({
						freshness: { observedAt: "2026-08-08T00:00:00.000Z", maxAgeSeconds: 0 },
					}),
				},
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_FRESHNESS_EXPIRED");
	});
	it("requires strict UTC timestamps and ordered windows", async () => {
		await expect(
			ingest({ input: envelope({ importedAt: "2026-02-30T00:00:00.000Z" }) }, context().ctx),
		).rejects.toThrow("SNAPSHOT_IMPORTED_AT_INVALID");
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: {
							...snapshot,
							window: { from: snapshot.window.to, to: snapshot.window.from },
						},
					}),
				},
				context().ctx,
			),
		).rejects.toThrow("METRIC_SNAPSHOT_WINDOW_ORDER_INVALID");
		await expect(
			ingest(
				{
					input: envelope({
						freshness: { observedAt: "2026-08-07T00:00:00.000Z", maxAgeSeconds: 31_536_000 },
					}),
				},
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_OBSERVED_AT_INVALID");
	});
	it("rejects unsafe warning messages and ratio inconsistencies", async () => {
		await expect(
			ingest(
				{ input: envelope({ snapshot: { ...snapshot, sampleWarnings: ["provider leaked PII"] } }) },
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_WARNING_INVALID");
		await expect(
			ingest(
				{ input: envelope({ snapshot: { ...snapshot, custom: { ctr: 1.1 } } }) },
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_RATIO_INVALID");
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: {
							...snapshot,
							funnel: { ...snapshot.funnel, ctaExposures: 0, ctaClicks: 0 },
							custom: { ctr: 0.4 },
						},
					}),
				},
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_RATIO_INVALID");
	});
	it("enforces independent definition, warning, map, and serialized bounds", async () => {
		const tooManyDefinitions = Array.from({ length: 101 }, (_, index) => ({
			id: `m${index}`,
			label: "M",
			unit: "count",
			source: sourceFormula("gsc"),
		}));
		await expect(
			ingest(
				{ input: envelope({ snapshot: { ...snapshot, definitions: tooManyDefinitions } }) },
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_BOUNDS_INVALID");
		const tooManyWarnings = Array.from({ length: 101 }).fill("LOW_SAMPLE");
		await expect(
			ingest(
				{ input: envelope({ snapshot: { ...snapshot, sampleWarnings: tooManyWarnings } }) },
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_BOUNDS_INVALID");
		const tooManyCustom = Object.fromEntries(
			Array.from({ length: 101 }, (_, index) => [`m${index}`, null]),
		);
		await expect(
			ingest(
				{ input: envelope({ snapshot: { ...snapshot, custom: tooManyCustom } }) },
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_BOUNDS_INVALID");
	});
	it("rejects future-invalid generated time", async () =>
		await expect(
			ingest(
				{ input: envelope({ snapshot: { ...snapshot, generatedAt: "2026-08-06T00:00:00.000Z" } }) },
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_GENERATED_AT_INVALID"));
	it("rejects duplicate definitions and bad references", async () => {
		const definitions = [
			{ id: "a", label: "A", unit: "count", source: "x" },
			{ id: "a", label: "A2", unit: "count", source: "x" },
		];
		await expect(
			ingest({ input: envelope({ snapshot: { ...snapshot, definitions } }) }, context().ctx),
		).rejects.toThrow("SNAPSHOT_DEFINITION_INVALID");
		const ratio = [
			{
				id: "r",
				label: "R",
				numerator: "missing",
				denominator: "d",
				unit: "ratio",
				source: sourceFormula("gsc"),
			},
		];
		await expect(
			ingest({ input: envelope({ snapshot: { ...snapshot, definitions: ratio } }) }, context().ctx),
		).rejects.toThrow("SNAPSHOT_DEFINITION_REFERENCE_INVALID");
	});
	it("rejects inconsistent funnel counts", async () => {
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: { ...snapshot, funnel: { ...snapshot.funnel, ctaClicks: 8 } },
					}),
				},
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_FUNNEL_INCONSISTENT");
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: { ...snapshot, funnel: { ...snapshot.funnel, impressions: 1, clicks: 2 } },
					}),
				},
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_FUNNEL_INCONSISTENT");
	});
	it("requires paired currency and revenue", async () =>
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: { ...snapshot, funnel: { ...snapshot.funnel, currency: "USD" } },
					}),
				},
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_CURRENCY_INVALID"));
	it("rejects non-lowercase source commit", async () =>
		await expect(
			ingest(
				{ input: envelope({ snapshot: { ...snapshot, sourceCommit: "A".repeat(40) } }) },
				context().ctx,
			),
		).rejects.toThrow());
	it("rejects storage read failures", async () =>
		await expect(ingest({ input: envelope() }, context({ getError: true }).ctx)).rejects.toThrow(
			"SNAPSHOT_STORAGE_READ_FAILED",
		));
	it("rejects malformed existing records and query shapes", async () => {
		await expect(
			ingest({ input: envelope() }, context({ existing: { bad: true } }).ctx),
		).rejects.toThrow("SNAPSHOT_STORAGE_CORRUPT");
		await expect(ingest({ input: envelope() }, context({ badQuery: true }).ctx)).rejects.toThrow(
			"SNAPSHOT_STORAGE_CORRUPT",
		);
	});
	it("rejects query failures", async () =>
		await expect(ingest({ input: envelope() }, context({ queryError: true }).ctx)).rejects.toThrow(
			"SNAPSHOT_STORAGE_READ_FAILED",
		));
	it("rejects write failures", async () =>
		await expect(ingest({ input: envelope() }, context({ putError: true }).ctx)).rejects.toThrow(
			"SNAPSHOT_STORAGE_WRITE_FAILED",
		));
	it("rejects total store limit", async () =>
		await expect(ingest({ input: envelope() }, context({ count: 1_000 }).ctx)).rejects.toThrow(
			"SNAPSHOT_STORAGE_LIMIT",
		));
	it("adapts five concrete aggregate row shapes without provider access", () => {
		const base = {
			version: 1,
			snapshotId: "s",
			contentId: "c",
			path: "/posts/a",
			from: "2026-08-01T00:00:00.000Z",
			to: "2026-08-07T00:00:00.000Z",
			generatedAt: "2026-08-08T00:00:00.000Z",
		};
		const outputs = [
			adaptSourceRow("gsc", { ...base, impressions: 10, clicks: 2 }),
			adaptSourceRow("ga4", { ...base, sessions: 10, pageViews: 8, conversions: 1 }),
			adaptSourceRow("first_party_funnel", {
				...base,
				sessions: 10,
				pageViews: 8,
				ctaExposures: 5,
				ctaClicks: 2,
				formStarts: 1,
				conversions: 1,
			}),
			adaptSourceRow("experiment", { ...base, exposures: 10, conversions: 1 }),
			adaptSourceRow("crm_revenue", {
				...base,
				qualifiedSessions: 10,
				conversions: 1,
				revenueMinor: 100,
				currency: "USD",
			}),
		];
		for (const [index, output] of outputs.entries()) {
			const source = SNAPSHOT_SOURCES[index]!;
			const normalized = normalizeSnapshotEnvelope({
				...envelope({ source, formulaVersion: sourceFormula(source), snapshot: output }),
			});
			expect(normalized.snapshot.target.kind).toBe("content");
			expect(JSON.stringify(normalized.snapshot)).toBe(
				JSON.stringify(
					normalizeSnapshotEnvelope({
						...envelope({ source, formulaVersion: sourceFormula(source), snapshot: output }),
					}).snapshot,
				),
			);
		}
	});
	it("rejects adapter excess fields and custom prototypes before normalization", () => {
		const row = {
			version: 1,
			snapshotId: "s",
			contentId: "c",
			path: "/posts/a",
			from: "2026-08-01T00:00:00.000Z",
			to: "2026-08-07T00:00:00.000Z",
			generatedAt: "2026-08-08T00:00:00.000Z",
			impressions: 10,
			clicks: 2,
			visitorId: "pii",
		};
		expect(() => adaptSourceRow("gsc", row)).toThrow("SOURCE_ROW_EXCESS");
		const polluted = Object.create({ credential: "secret" });
		Object.assign(polluted, { ...row, visitorId: undefined });
		expect(() => adaptSourceRow("gsc", polluted)).toThrow("SOURCE_ROW_INVALID");
	});
	it("proves exact upper bounds, serialized rejection, and detached canonical values", async () => {
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: {
							...snapshot,
							definitions: Array.from({ length: 100 }, (_, index) => ({
								id: `m${index}`,
								label: "M",
								unit: "count",
								source: sourceFormula("gsc"),
							})),
							custom: {},
						},
					}),
				},
				context().ctx,
			),
		).resolves.toMatchObject({ accepted: true });
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: {
							...snapshot,
							sampleWarnings: Array.from({ length: 100 }).fill("LOW_SAMPLE"),
						},
					}),
				},
				context().ctx,
			),
		).resolves.toMatchObject({ accepted: true });
		await expect(
			ingest(
				{
					input: envelope({
						snapshot: {
							...snapshot,
							definitions: Array.from({ length: 100 }, (_, index) => ({
								id: `m${index}`,
								label: "x".repeat(128),
								unit: "count",
								source: sourceFormula("gsc"),
							})),
							custom: {},
						},
					}),
				},
				context().ctx,
			),
		).rejects.toThrow("SNAPSHOT_SERIALIZED_LIMIT");
		const input = envelope();
		const c = context();
		await ingest({ input }, c.ctx);
		expect(stored(c.put).target).not.toBe(input.snapshot.target);
		expect(stored(c.put).custom).not.toBe(input.snapshot.custom);
	});
	it("rejects invalid existing ISO records with a stable corruption code", async () => {
		const c = context();
		await ingest({ input: envelope() }, c.ctx);
		const record = stored(c.put);
		record.generatedAt = "2026-99-99T00:00:00.000Z";
		await expect(
			ingest(
				{
					input: envelope({
						importedAt: "2026-08-10T00:00:00.000Z",
						freshness: { observedAt: "2026-08-09T00:00:00.000Z", maxAgeSeconds: 86_400 },
					}),
				},
				c.ctx,
			),
		).rejects.toThrow("SNAPSHOT_STORAGE_CORRUPT");
	});
	it("canonical digest ignores object insertion order", async () => {
		const a = context();
		const b = context();
		await ingest(
			{
				input: envelope({
					freshness: { observedAt: "2026-08-08T00:00:00.000Z", maxAgeSeconds: 86_400 },
				}),
			},
			a.ctx,
		);
		await ingest(
			{
				input: envelope({
					freshness: { maxAgeSeconds: 86_400, observedAt: "2026-08-08T00:00:00.000Z" },
				}),
			},
			b.ctx,
		);
		expect(stored(a.put).digest).toBe(stored(b.put).digest);
	});
	it("rejects every adapter source/row-shape mismatch", () => {
		const base = {
			version: 1,
			snapshotId: "s",
			contentId: "c",
			path: "/posts/a",
			from: "2026-08-01T00:00:00.000Z",
			to: "2026-08-07T00:00:00.000Z",
			generatedAt: "2026-08-08T00:00:00.000Z",
		};
		const rows = [
			{ ...base, impressions: 1, clicks: 1 },
			{ ...base, sessions: 1, pageViews: 1, conversions: 1 },
			{
				...base,
				sessions: 1,
				pageViews: 1,
				ctaExposures: 1,
				ctaClicks: 1,
				formStarts: 1,
				conversions: 1,
			},
			{ ...base, exposures: 1, conversions: 1 },
			{ ...base, qualifiedSessions: 1, conversions: 1, revenueMinor: 1, currency: "USD" },
		];
		for (let index = 0; index < rows.length; index += 1)
			expect(() =>
				adaptSourceRow(SNAPSHOT_SOURCES[(index + 1) % rows.length]!, rows[index]! as never),
			).toThrow(/SOURCE_ROW/);
	});
	it("does not mutate input", async () => {
		const input = envelope();
		const before = JSON.stringify(input);
		await ingest({ input }, context().ctx);
		expect(JSON.stringify(input)).toBe(before);
	});
	it("digest includes envelope metadata", async () => {
		const a = context();
		const b = context();
		await ingest({ input: envelope() }, a.ctx);
		await ingest(
			{
				input: envelope({
					importedAt: "2026-08-10T00:00:00.000Z",
					freshness: { observedAt: "2026-08-09T00:00:00.000Z", maxAgeSeconds: 86_400 },
				}),
			},
			b.ctx,
		);
		expect(stored(a.put).digest).not.toBe(stored(b.put).digest);
	});
});
