import { describe, expect, it, vi } from "vitest";

import { contentInsightsPlugin } from "../src/index.js";
import plugin from "../src/sandbox-entry.js";

const input = {
	collection: "posts",
	locale: "en",
	contentId: "content-alpha",
	path: "/posts/alpha",
	source: "gsc",
	formulaVersion: "gsc-search-analytics-v1",
	window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-07T00:00:00.000Z" },
	limit: 10,
	asOf: "2026-08-08T12:00:00.000Z",
};
const record = {
	version: 1,
	snapshotId: "s1",
	collection: "posts",
	locale: "en",
	source: "gsc",
	formulaVersion: "gsc-search-analytics-v1",
	generatedAt: "2026-08-08T00:00:00.000Z",
	targetKey: "content-alpha:/posts/alpha",
	target: { kind: "content", contentId: "content-alpha", path: "/posts/alpha" },
	window: input.window,
	importedAt: "2026-08-09T00:00:00.000Z",
	freshness: { observedAt: "2026-08-08T00:00:00.000Z", maxAgeSeconds: 86_400 },
	definitions: [
		{
			id: "ctr",
			label: "CTR",
			unit: "ratio",
			source: "gsc-search-analytics-v1",
			denominator: "impressions",
		},
	],
	funnel: { impressions: 10 },
	custom: { ctr: 0.2 },
	sampleWarnings: ["LOW_SAMPLE"],
	digest: "sha256:" + "a".repeat(64),
};

const summary = (
	plugin as unknown as {
		routes: Record<string, { handler: (route: unknown, ctx: unknown) => Promise<unknown> }>;
	}
).routes.summary.handler;
const adminSummary = (
	plugin as unknown as {
		routes: Record<string, { handler: (route: unknown, ctx: unknown) => Promise<unknown> }>;
	}
).routes.adminSummary.handler;
function context(
	item: unknown = {
		id: "content-alpha",
		status: "published",
		locale: "en",
		type: "post",
		slug: "alpha",
	},
	items = [record],
	queryError = false,
) {
	const query = vi.fn(async () => {
		if (queryError) throw new Error("provider secret");
		return {
			items: items.map((data) => ({ id: data.snapshotId, data })),
			cursor: "next",
			hasMore: true,
		};
	});
	return {
		ctx: { content: { get: vi.fn(async () => item) }, storage: { snapshots: { query } } },
		query,
	};
}

describe("content insight summary routes", () => {
	it("keeps summary routes private and permissioned", () => {
		const descriptor = contentInsightsPlugin();
		expect(descriptor.capabilities).toEqual(["content:read"]);
		expect((plugin as any).routes.summary.public).not.toBe(true);
		expect((plugin as any).routes.summary.permission).toBe("content:read");
		expect((plugin as any).routes.adminSummary.permission).toBe("plugins:manage");
	});
	it("queries the indexed target key with bounded descending pagination", async () => {
		const c = context();
		await summary({ input }, c.ctx);
		expect(c.query).toHaveBeenCalledWith({
			where: { targetKey: "content-alpha:/posts/alpha" },
			orderBy: { generatedAt: "desc", snapshotId: "asc" },
			limit: 11,
			cursor: undefined,
		});
	});
	it("returns explicit evidence and metric uncertainty only", async () => {
		const result = (await summary({ input }, context().ctx)) as Record<string, unknown>;
		expect(result).toMatchObject({
			content: { id: "content-alpha", locale: "en" },
			source: "gsc",
			formulaVersion: "gsc-search-analytics-v1",
			window: input.window,
		});
		expect(result).toHaveProperty("evidence");
		expect(JSON.stringify(result)).not.toMatch(/visitor|rawEvent|credential|password|data|body/u);
	});
	it("marks sample threshold and preserves freshness/definitions", async () => {
		const result = (await summary({ input }, context().ctx)) as Record<string, unknown>;
		expect(result.summaries).toEqual([
			expect.objectContaining({
				snapshotId: "s1",
				digest: record.digest,
				metrics: { ctr: 0.2 },
				uncertainty: ["sample_threshold"],
			}),
		]);
		expect(result.freshness).toEqual([record.freshness]);
	});
	it("rechecks published content before summary", async () => {
		await expect(
			summary(
				{ input },
				context({ id: "content-alpha", status: "draft", locale: "en", type: "post", slug: "alpha" })
					.ctx,
			),
		).rejects.toThrow("SUMMARY_CONTENT_NOT_PUBLISHED");
	});
	it("admin route also returns the same bounded shape", async () => {
		const result = (await adminSummary({ input }, context().ctx)) as Record<string, unknown>;
		expect(result).toHaveProperty("evidence");
	});
	it("rejects excess, unbounded, and malformed input", async () => {
		await expect(summary({ input: { ...input, secret: "x" } }, context().ctx)).rejects.toThrow(
			"SUMMARY_INPUT_EXCESS",
		);
		await expect(summary({ input: { ...input, limit: 101 } }, context().ctx)).rejects.toThrow(
			"SUMMARY_LIMIT_INVALID",
		);
		await expect(summary({ input: { ...input, window: null } }, context().ctx)).rejects.toThrow(
			"SUMMARY_INPUT_INVALID",
		);
	});
	it("returns no-data without leaking storage internals", async () => {
		const result = (await summary({ input }, context(undefined, [], false).ctx)) as Record<
			string,
			unknown
		>;
		expect(result.summaries).toEqual([]);
		expect(result.evidence).toEqual([]);
	});
	it("trims limit-plus-one results and exposes the next cursor", async () => {
		const result = (await summary(
			{ input: { ...input, limit: 1 } },
			context(undefined, [
				record,
				{ ...record, snapshotId: "s2", digest: "sha256:" + "b".repeat(64) },
			]).ctx,
		)) as Record<string, unknown>;
		expect(result.summaries).toHaveLength(1);
		expect(result.nextCursor).toBe("next");
		expect(result.hasMore).toBe(true);
	});
	it("rejects storage/provider failures with stable summary code", async () => {
		await expect(summary({ input }, context(undefined, [record], true).ctx)).rejects.toThrow(
			"SUMMARY_STORAGE_READ_FAILED",
		);
	});
	it("rejects unsafe path and malformed strict window", async () => {
		await expect(
			summary({ input: { ...input, path: "/posts/../alpha" } }, context().ctx),
		).rejects.toThrow("SUMMARY_INPUT_INVALID");
		await expect(
			summary(
				{ input: { ...input, window: { from: "2026-02-30T00:00:00.000Z", to: input.window.to } } },
				context().ctx,
			),
		).rejects.toThrow("SUMMARY_INPUT_INVALID");
	});
	it("rejects missing, unknown, and locale-mismatched content", async () => {
		await expect(
			summary({ input }, { content: undefined, storage: context().ctx.storage } as unknown),
		).rejects.toThrow("CONTENT_READ_REQUIRED");
		await expect(
			summary(
				{ input },
				context({ id: "other", status: "published", locale: "en", type: "post", slug: "alpha" })
					.ctx,
			),
		).rejects.toThrow("SUMMARY_CONTENT_NOT_PUBLISHED");
		await expect(
			summary(
				{ input },
				context({
					id: "content-alpha",
					status: "published",
					locale: "fr",
					type: "post",
					slug: "alpha",
				}).ctx,
			),
		).rejects.toThrow("SUMMARY_CONTENT_LOCALE_MISMATCH");
	});
	it("aggregates compatible records deterministically", async () => {
		const result = (await summary(
			{ input },
			context(undefined, [record, { ...record, snapshotId: "s2", funnel: { impressions: 20 } }])
				.ctx,
		)) as Record<string, any>;
		expect(result.funnel.impressions).toBe(30);
		expect(result.groups).toHaveLength(1);
	});
	it("does not aggregate incompatible formula groups", async () => {
		const result = (await summary(
			{ input: { ...input, source: undefined, formulaVersion: undefined } },
			context(undefined, [
				record,
				{
					...record,
					snapshotId: "s2",
					source: "ga4",
					formulaVersion: "ga4-analytics-v1",
					definitions: record.definitions.map((definition) => ({
						...definition,
						source: "ga4-analytics-v1",
					})),
				},
			]).ctx,
		)) as Record<string, any>;
		expect(result.funnel).toEqual({});
		expect(result.uncertainty).toContain("incompatible_definition");
	});
	it("does not aggregate incompatible currencies", async () => {
		const result = (await summary(
			{ input: { ...input, source: undefined, formulaVersion: undefined } },
			context(undefined, [
				record,
				{ ...record, snapshotId: "s2", funnel: { impressions: 20, currency: "USD" } },
			]).ctx,
		)) as Record<string, any>;
		expect(result.funnel).toEqual({});
	});
	it("suppresses low sample diagnosis below fixed threshold", async () => {
		const result = (await summary(
			{ input },
			context(undefined, [{ ...record, sampleWarnings: [] }]).ctx,
		)) as Record<string, any>;
		expect(result.summaries[0].diagnosis[0].rate).toBeNull();
		expect(result.summaries[0].bottleneck).toBeNull();
	});
	it("suppresses zero denominator and inconsistent numerator", async () => {
		const result = (await summary(
			{ input },
			context(undefined, [{ ...record, funnel: { impressions: 0, clicks: 2 } }]).ctx,
		)) as Record<string, any>;
		expect(result.summaries[0].diagnosis[0].rate).toBeNull();
		const invalid = (await summary(
			{ input },
			context(undefined, [{ ...record, funnel: { impressions: 30, clicks: 31 } }]).ctx,
		)) as Record<string, any>;
		expect(invalid.summaries[0].diagnosis[0].rate).toBeNull();
	});
	it("uses valid funnel edges and deterministic bottleneck", async () => {
		const result = (await summary(
			{ input },
			context(undefined, [
				{
					...record,
					sampleWarnings: [],
					funnel: {
						impressions: 100,
						clicks: 40,
						ctaExposures: 50,
						ctaClicks: 10,
						formStarts: 2,
						conversions: 1,
					},
				},
			]).ctx,
		)) as Record<string, any>;
		expect(result.summaries[0].diagnosis.map((step: any) => step.id)).toEqual([
			"clicks",
			"ctaClicks",
			"formStarts",
			"conversions",
		]);
		expect(result.summaries[0].bottleneck).toBe("ctaClicks");
	});
	it("sorts equal-window records by generated time then snapshot id", async () => {
		const result = (await summary(
			{ input },
			context(undefined, [
				{ ...record, snapshotId: "z" },
				{ ...record, snapshotId: "a" },
			]).ctx,
		)) as Record<string, any>;
		expect(result.summaries.map((item: any) => item.snapshotId)).toEqual(["a", "z"]);
	});
	it("keeps multi-source evidence explicit", async () => {
		const result = (await summary(
			{ input: { ...input, source: undefined, formulaVersion: undefined } },
			context(undefined, [
				record,
				{
					...record,
					snapshotId: "s2",
					source: "ga4",
					formulaVersion: "ga4-analytics-v1",
					definitions: record.definitions.map((definition) => ({
						...definition,
						source: "ga4-analytics-v1",
					})),
				},
			]).ctx,
		)) as Record<string, any>;
		expect(result.sources).toEqual(["ga4", "gsc"]);
		expect(result.evidence).toHaveLength(2);
	});
	it("rejects corrupted source and formula without echoing provider text", async () => {
		await expect(
			summary({ input }, context(undefined, [{ ...record, source: "provider secret" }]).ctx),
		).rejects.toThrow("SUMMARY_STORAGE_CORRUPT");
		await expect(
			summary(
				{ input },
				context(undefined, [{ ...record, formulaVersion: "credential-token" }]).ctx,
			),
		).rejects.toThrow("SUMMARY_STORAGE_CORRUPT");
	});
	it("rejects missing generated time and credential-like definition source", async () => {
		await expect(
			summary({ input }, context(undefined, [{ ...record, generatedAt: undefined }]).ctx),
		).rejects.toThrow("SUMMARY_STORAGE_CORRUPT");
		await expect(
			summary(
				{ input },
				context(undefined, [
					{ ...record, definitions: [{ ...record.definitions[0], source: "credential" }] },
				]).ctx,
			),
		).rejects.toThrow("SUMMARY_STORAGE_CORRUPT");
	});
	it("does not expose raw storage fields from recent", async () => {
		const recent = (plugin as any).routes.recent.handler;
		const result = (await recent(
			{},
			{
				storage: {
					snapshots: { query: vi.fn(async () => ({ items: [{ data: { credential: "x" } }] })) },
					proposals: { query: vi.fn(async () => ({ items: [] })) },
					experiments: { query: vi.fn(async () => ({ items: [] })) },
				},
			},
		)) as Record<string, any>;
		expect(result.snapshots).toEqual([]);
	});
});
