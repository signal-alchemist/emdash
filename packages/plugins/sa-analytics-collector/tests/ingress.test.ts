import { describe, expect, it, vi } from "vitest";

import {
	createAnalyticsForwarder,
	ingestAnalytics,
	ANALYTICS_UPSTREAM,
	type AnalyticsIngressOptions,
} from "../src/ingress.js";

const batch = {
	version: 1,
	consent: {
		state: "granted",
		policyVersion: 1,
		grantedAt: "2026-08-25T00:00:00Z",
		expiresAt: "2026-08-26T00:00:00Z",
	},
	events: [
		{
			version: 1,
			eventId: "event-1",
			eventName: "page_view",
			occurredAt: "2026-08-25T00:01:00Z",
			anonymousId: "anon-1",
			sessionId: "session-1",
			path: "/lp",
			payload: {},
		},
	],
};
const ctx = (input: unknown = batch, origin = "https://site.test") =>
	({
		input,
		request: new Request(
			"https://site.test/_emdash/api/plugins/sa-analytics-collector/analytics/collect",
			{ method: "POST", headers: { origin, "content-type": "application/json" } },
		),
		requestMeta: { ip: "203.0.113.1", userAgent: null, referer: null, geo: null },
	}) as any;
const controls = (overrides: Partial<AnalyticsIngressOptions> = {}): AnalyticsIngressOptions => ({
	secret: "test-secret",
	keyId: "k1",
	limiter: { reserve: vi.fn(async () => ({ commit: vi.fn(), rollback: vi.fn() })) },
	forwarder: { forward: vi.fn(async () => "accepted" as const) },
	now: () => Date.parse("2026-08-25T01:00:00Z"),
	...overrides,
});

describe("analytics ingress", () => {
	it("requires exact same-origin and validates before reservation", async () => {
		const c = controls();
		await expect(ingestAnalytics(ctx(batch, "https://evil.test"), c)).rejects.toMatchObject({
			code: "ANALYTICS_ORIGIN_INVALID",
		});
		await expect(
			ingestAnalytics(ctx({ ...batch, version: 2 }, "https://site.test"), c),
		).rejects.toMatchObject({ code: "ANALYTICS_BATCH_INVALID" });
		expect(c.limiter.reserve).not.toHaveBeenCalled();
	});
	it("rejects missing configuration and components before side effects", async () => {
		await expect(ingestAnalytics(ctx(), undefined)).rejects.toMatchObject({
			code: "ANALYTICS_NOT_CONFIGURED",
			status: 503,
		});
		await expect(
			ingestAnalytics(ctx(), { ...controls(), limiter: undefined as never }),
		).rejects.toMatchObject({ code: "ANALYTICS_NOT_CONFIGURED" });
		await expect(ingestAnalytics(ctx(), { ...controls(), secret: "" })).rejects.toMatchObject({
			code: "ANALYTICS_NOT_CONFIGURED",
		});
		await expect(ingestAnalytics(ctx(), { ...controls(), keyId: "" })).rejects.toMatchObject({
			code: "ANALYTICS_NOT_CONFIGURED",
		});
		await expect(
			ingestAnalytics(ctx(), { ...controls(), forwarder: undefined as never }),
		).rejects.toMatchObject({ code: "ANALYTICS_NOT_CONFIGURED" });
	});
	it("enforces media type, origin, client identity, and durable limiter outcomes", async () => {
		const base = controls();
		await expect(
			ingestAnalytics(
				{ ...ctx(), request: new Request("https://site.test/", { method: "POST" }) },
				base,
			),
		).rejects.toMatchObject({ code: "ANALYTICS_CONTENT_TYPE_INVALID", status: 415 });
		await expect(
			ingestAnalytics(
				{
					...ctx(),
					request: new Request("https://site.test/", {
						method: "POST",
						headers: { "content-type": "text/plain" },
					}),
				},
				base,
			),
		).rejects.toMatchObject({ code: "ANALYTICS_CONTENT_TYPE_INVALID" });
		await expect(
			ingestAnalytics(
				{
					...ctx(),
					request: new Request("https://site.test/", {
						method: "POST",
						headers: { "content-type": "application/json" },
					}),
				},
				base,
			),
		).rejects.toMatchObject({ code: "ANALYTICS_ORIGIN_INVALID", status: 403 });
		await expect(
			ingestAnalytics({ ...ctx(), requestMeta: { ...ctx().requestMeta, ip: null } }, base),
		).rejects.toMatchObject({ code: "ANALYTICS_CLIENT_UNTRUSTED", status: 400 });
		const reserve = vi.fn(async () => null);
		await expect(ingestAnalytics(ctx(), controls({ limiter: { reserve } }))).rejects.toMatchObject({
			code: "ANALYTICS_RATE_LIMITED",
			status: 429,
		});
		const allow = controls({ botDecision: () => "allow" });
		await expect(ingestAnalytics(ctx(), allow)).resolves.toEqual({ accepted: true });
	});
	it("rejects trusted bot decisions before reservation and forwards with idempotency", async () => {
		const c = controls({ botDecision: () => "reject" });
		await expect(ingestAnalytics(ctx(), c)).rejects.toMatchObject({
			code: "ANALYTICS_BOT_REJECTED",
		});
		expect(c.limiter.reserve).not.toHaveBeenCalled();
		const good = controls();
		await expect(ingestAnalytics(ctx(), good)).resolves.toEqual({ accepted: true });
		expect(good.forwarder.forward).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringMatching(/^[a-f0-9]{64}$/),
			expect.any(AbortSignal),
		);
	});
	it("rolls back once for upstream rejection", async () => {
		const rollback = vi.fn();
		const commit = vi.fn();
		const c = controls({
			limiter: { reserve: vi.fn(async () => ({ commit, rollback })) },
			forwarder: { forward: vi.fn(async () => "rejected" as const) },
		});
		await expect(ingestAnalytics(ctx(), c)).rejects.toMatchObject({
			code: "ANALYTICS_UPSTREAM_REJECTED",
		});
		expect(rollback).toHaveBeenCalledTimes(1);
		expect(commit).not.toHaveBeenCalled();
	});
	it("uses a rotating pseudonymous rate key and stable batch idempotency", async () => {
		const reserve = vi.fn(async () => ({ commit: vi.fn(), rollback: vi.fn() }));
		const forward = vi.fn(async () => "accepted" as const);
		const first = controls({
			limiter: { reserve },
			forwarder: { forward },
			now: () => Date.parse("2026-08-25T01:00:00Z"),
		});
		await ingestAnalytics(ctx(), first);
		const firstRateKey = reserve.mock.calls[0]![0];
		const firstIdempotency = forward.mock.calls[0]![1];
		const second = controls({
			limiter: { reserve },
			forwarder: { forward },
			now: () => Date.parse("2026-08-25T01:01:00Z"),
		});
		await ingestAnalytics(
			{ ...ctx(), requestMeta: { ...ctx().requestMeta, ip: "198.51.100.8" } },
			second,
		);
		expect(reserve.mock.calls[1]![0]).not.toBe(firstRateKey);
		expect(forward.mock.calls[1]![1]).toBe(firstIdempotency);
		expect(firstRateKey).not.toContain("203.0.113.1");
		expect(firstRateKey).not.toContain("test-secret");
		expect(firstRateKey).not.toContain("event-1");
	});
	it("maps limiter failures and rejects unsupported methods before side effects", async () => {
		const reserve = vi.fn(async () => {
			throw new Error("down");
		});
		const c = controls({ limiter: { reserve } });
		await expect(ingestAnalytics(ctx(), c)).rejects.toMatchObject({
			code: "ANALYTICS_RATE_LIMIT_UNAVAILABLE",
			status: 503,
		});
		const bad = { ...ctx(), request: new Request("https://site.test/", { method: "GET" }) };
		await expect(ingestAnalytics(bad, c)).rejects.toMatchObject({
			code: "ANALYTICS_METHOD_NOT_ALLOWED",
			status: 405,
		});
		expect(reserve).toHaveBeenCalledTimes(1);
	});
	it("creates only the fixed HTTPS forwarder and never reflects upstream bodies", async () => {
		await expect(() => createAnalyticsForwarder("https://evil.test/events")).toThrow();
		const fetchMock = vi.fn(async () => new Response("secret upstream body", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const result = await createAnalyticsForwarder(ANALYTICS_UPSTREAM).forward(
			"{}",
			"id-1",
			new AbortController().signal,
		);
		expect(result).toBe("accepted");
		expect(fetchMock).toHaveBeenCalledWith(
			ANALYTICS_UPSTREAM,
			expect.objectContaining({ redirect: "error", body: "{}" }),
		);
		vi.unstubAllGlobals();
	});
	it("maps fixed forwarder non-success and thrown fetch responses", async () => {
		for (const [fetchMock, status] of [
			vi.fn(async () => new Response("private upstream detail", { status: 503 })),
			vi.fn(async () => {
				throw new Error("network");
			}),
		].map((fetchImpl, index) => [fetchImpl, index === 0 ? 502 : 503] as const)) {
			vi.stubGlobal("fetch", fetchMock);
			await expect(
				ingestAnalytics(ctx(), controls({ forwarder: createAnalyticsForwarder() })),
			).rejects.toMatchObject({ status });
			vi.unstubAllGlobals();
		}
	});
	it("captures the clock once before validation and rate reservation", async () => {
		const now = vi.fn(() => {
			return Date.parse("2026-08-25T01:00:00Z");
		});
		await ingestAnalytics(ctx(), controls({ now }));
		expect(now).toHaveBeenCalledOnce();
	});
	it("maps network and abort failures while rolling back exactly once", async () => {
		for (const failure of [new Error("network"), new DOMException("timed out", "AbortError")]) {
			const rollback = vi.fn();
			const c = controls({
				limiter: { reserve: vi.fn(async () => ({ commit: vi.fn(), rollback })) },
				forwarder: {
					forward: vi.fn(async () => {
						throw failure;
					}),
				},
			});
			await expect(ingestAnalytics(ctx(), c)).rejects.toMatchObject({ status: 503 });
			expect(rollback).toHaveBeenCalledOnce();
		}
	});
	it("reports commit and rollback failures without double settlement", async () => {
		const commit = vi.fn(async () => {
			throw new Error("commit");
		});
		const rollback = vi.fn(async () => undefined);
		const c = controls({ limiter: { reserve: vi.fn(async () => ({ commit, rollback })) } });
		await expect(ingestAnalytics(ctx(), c)).rejects.toMatchObject({
			code: "ANALYTICS_RATE_COMMIT_FAILED",
		});
		expect(commit).toHaveBeenCalledOnce();
		expect(rollback).toHaveBeenCalledOnce();
		const badRollback = controls({
			limiter: {
				reserve: vi.fn(async () => ({
					commit: vi.fn(),
					rollback: vi.fn(async () => {
						throw new Error("rollback");
					}),
				})),
			},
			forwarder: { forward: vi.fn(async () => "rejected" as const) },
		});
		await expect(ingestAnalytics(ctx(), badRollback)).rejects.toMatchObject({
			code: "ANALYTICS_RATE_ROLLBACK_FAILED",
		});
	});
});
