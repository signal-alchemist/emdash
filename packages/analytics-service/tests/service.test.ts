import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	cleanupAnalytics,
	exportAggregates,
	ingestAnalyticsBatch,
	AnalyticsStoreHandle,
	MemoryAnalyticsBackend,
	readBoundedJson,
	validateRetention,
} from "../src/index.js";

const batch = (eventName = "page_view", occurredAt = "2026-01-02T00:00:00Z") => ({
	version: 1,
	consent: {
		state: "granted",
		policyVersion: 1,
		grantedAt: "2026-01-01T00:00:00Z",
		expiresAt: "2026-01-10T00:00:00Z",
	},
	events: [
		{
			version: 1,
			eventId: `e-${eventName}`,
			eventName,
			occurredAt,
			anonymousId: "a",
			sessionId: "s",
			path: "/lp",
			payload: eventName === "cta_click" ? { elementId: "cta" } : {},
		},
	],
});
const secret = "test-secret-0123456789";
const clock = () => Date.parse("2026-01-03T00:00:00Z");
const request = (value: unknown, key = "batch-1", extra: Record<string, string> = {}) => {
	const body = JSON.stringify(value);
	const signature = createHmac("sha256", secret).update(body).digest("hex");
	return new Request("https://analytics.test/v1/events", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"x-analytics-version": "1",
			"x-idempotency-key": key,
			"x-analytics-signature": `sha256=${signature}`,
			...extra,
		},
	});
};

describe("durable analytics service production handler", () => {
	it("stores identical ingestion once and converges on replay", async () => {
		const store = new MemoryAnalyticsBackend();
		const a = await ingestAnalyticsBatch(request(batch()), store, { secret, now: clock });
		const b = await ingestAnalyticsBatch(request(batch()), store, { secret, now: clock });
		expect(a.status).toBe(202);
		expect(b.body.accepted).toBe(true);
		expect((await store.page(null, 10)).rows).toHaveLength(1);
	});
	it("atomically converges two contexts over one shared backend", async () => {
		const backend = new MemoryAnalyticsBackend();
		let arrived = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitForPeers = async () => {
			arrived++;
			if (arrived === 2) release();
			await gate;
		};
		const first = new AnalyticsStoreHandle(backend, waitForPeers);
		const second = new AnalyticsStoreHandle(backend, waitForPeers);
		const barrier = Promise.all([
			ingestAnalyticsBatch(request(batch(), "barrier"), first, { secret, now: clock }),
			ingestAnalyticsBatch(request(batch(), "barrier"), second, { secret, now: clock }),
		]);
		const results = await barrier;
		expect(results.map((r) => r.status).toSorted()).toEqual([202, 202]);
		expect(arrived).toBe(2);
		expect((await backend.page(null, 10)).rows).toHaveLength(1);
	});
	it("rejects same idempotency key with a different body", async () => {
		const store = new MemoryAnalyticsBackend();
		await ingestAnalyticsBatch(request(batch(), "same"), store, { secret, now: clock });
		const result = await ingestAnalyticsBatch(request(batch("cta_click"), "same"), store, {
			secret,
			now: clock,
		});
		expect(result).toMatchObject({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } });
	});
	it("rejects malformed, unauthorized, oversized, and forbidden payloads", async () => {
		const store = new MemoryAnalyticsBackend();
		const noAuth = new Request("https://analytics.test/v1/events", {
			method: "POST",
			body: JSON.stringify(batch()),
			headers: {
				"content-type": "application/json",
				"x-analytics-version": "1",
				"x-idempotency-key": "x",
			},
		});
		expect((await ingestAnalyticsBatch(noAuth, store, { secret })).status).toBe(401);
		expect(
			(
				await ingestAnalyticsBatch(request(batch(), "x", { "content-length": "1" }), store, {
					secret,
				})
			).status,
		).toBe(400);
		expect(
			(
				await ingestAnalyticsBatch(
					request({
						...batch(),
						events: [{ ...batch().events[0], payload: { sessionReplay: "secret" } }],
					}),
					store,
					{ secret, now: clock },
				)
			).status,
		).toBe(400);
	});
	it("requires exact protocol headers and constant-time service authentication", async () => {
		const store = new MemoryAnalyticsBackend();
		const wrong = request(batch(), "x", { "x-analytics-version": "2" });
		expect((await ingestAnalyticsBatch(wrong, store, { secret, now: clock })).status).toBe(400);
		const media = request(batch(), "x", { "content-type": "text/plain" });
		expect((await ingestAnalyticsBatch(media, store, { secret, now: clock })).status).toBe(415);
	});
	it("fails closed for invalid retention and exports bounded aggregates without raw fields", async () => {
		expect(() => validateRetention({ default: 1 })).toThrow();
		const store = new MemoryAnalyticsBackend();
		await ingestAnalyticsBatch(request(batch(), "a"), store, { secret, now: clock });
		await ingestAnalyticsBatch(request(batch("cta_click"), "b"), store, { secret, now: clock });
		const output = await exportAggregates(store, {
			from: Date.parse("2026-01-01T00:00:00Z"),
			to: Date.parse("2026-01-03T00:00:00Z"),
		});
		expect(output).toEqual([
			{
				eventName: "cta_click",
				count: 1,
				firstAt: Date.parse("2026-01-02T00:00:00Z"),
				lastAt: Date.parse("2026-01-02T00:00:00Z"),
			},
			{
				eventName: "page_view",
				count: 1,
				firstAt: Date.parse("2026-01-02T00:00:00Z"),
				lastAt: Date.parse("2026-01-02T00:00:00Z"),
			},
		]);
		expect(JSON.stringify(output)).not.toContain("anonymousId");
	});
	it("deletes at exact expiry boundary and receipts are retry-safe", async () => {
		const store = new MemoryAnalyticsBackend();
		await ingestAnalyticsBatch(request(batch(), "a"), store, {
			secret,
			now: () => Date.parse("2026-01-02T00:00:00Z"),
		});
		const receipt = await cleanupAnalytics(
			store,
			{ default: 86_400_000 },
			Date.parse("2026-01-03T00:00:00Z"),
		);
		expect(receipt.deleted).toBe(1);
		expect(
			(await cleanupAnalytics(store, { default: 86_400_000 }, Date.parse("2026-01-03T00:00:00Z")))
				.deleted,
		).toBe(1);
	});
	it("retains a mixed batch until every event class expires", async () => {
		const store = new MemoryAnalyticsBackend();
		await ingestAnalyticsBatch(request(batch(), "mixed"), store, {
			secret,
			now: () => Date.parse("2026-01-02T00:00:00Z"),
		});
		const receipt = await cleanupAnalytics(
			store,
			{ default: 86_400_000, page_view: 172_800_000 },
			Date.parse("2026-01-03T00:00:00Z"),
		);
		expect(receipt.deleted).toBe(0);
		expect((await store.page(null, 10)).rows).toHaveLength(1);
	});
	it("returns cleanup in-progress for a competing context", async () => {
		const store = new MemoryAnalyticsBackend();
		store.claimOrResumeCleanup = async () => ({ state: "in_progress" });
		await expect(cleanupAnalytics(store, { default: 86_400_000 }, 1)).rejects.toThrow(
			"CLEANUP_IN_PROGRESS",
		);
	});
	it("allows exactly one cleanup owner across two store handles", async () => {
		const backend = new MemoryAnalyticsBackend();
		const first = new AnalyticsStoreHandle(backend);
		const second = new AnalyticsStoreHandle(backend);
		const results = await Promise.allSettled([
			cleanupAnalytics(first, { default: 86_400_000 }, Date.parse("2026-01-03T00:00:00Z")),
			cleanupAnalytics(second, { default: 86_400_000 }, Date.parse("2026-01-03T00:00:00Z")),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});
	it("binds cleanup identity to cutoff while lease clock may advance", async () => {
		const store = new MemoryAnalyticsBackend();
		const first = await cleanupAnalytics(
			store,
			{ default: 86_400_000 },
			{ cutoffAt: Date.parse("2026-01-03T00:00:00Z"), leaseNow: 1 },
		);
		const retry = await cleanupAnalytics(
			store,
			{ default: 86_400_000 },
			{ cutoffAt: Date.parse("2026-01-03T00:00:00Z"), leaseNow: 2 },
		);
		const nextCutoff = await cleanupAnalytics(
			store,
			{ default: 86_400_000 },
			{ cutoffAt: Date.parse("2026-01-03T00:00:01Z"), leaseNow: 3 },
		);
		expect(retry.id).toBe(first.id);
		expect(nextCutoff.id).not.toBe(first.id);
	});
	it("takes over a crashed cleanup after lease expiry and preserves canonical count", async () => {
		const store = new MemoryAnalyticsBackend();
		expect(
			await ingestAnalyticsBatch(request(batch(), "crash"), store, {
				secret,
				now: () => Date.parse("2026-01-02T00:00:00Z"),
			}),
		).toMatchObject({ status: 202 });
		const originalPage = store.page.bind(store);
		let failed = true;
		store.page = async (...args) => {
			if (failed) {
				failed = false;
				throw new Error("page failure");
			}
			return originalPage(...args);
		};
		const cutoffAt = Date.parse("2026-01-03T00:00:00Z");
		await expect(
			cleanupAnalytics(store, { default: 86_400_000 }, { cutoffAt, leaseNow: cutoffAt }),
		).rejects.toThrow("ANALYTICS_STORAGE_PAGE_FAILED");
		expect((await store.page(null, 10)).rows).toHaveLength(1);
		const receipt = await cleanupAnalytics(
			store,
			{ default: 86_400_000 },
			{ cutoffAt, leaseNow: cutoffAt + 2_000 },
		);
		expect(receipt.deleted).toBe(1);
		expect(
			(
				await cleanupAnalytics(
					store,
					{ default: 86_400_000 },
					{ cutoffAt, leaseNow: cutoffAt + 2_000 },
				)
			).id,
		).toBe(receipt.id);
	});
	it("recounts deleted progress after finalize failure without double counting", async () => {
		const store = new MemoryAnalyticsBackend();
		await ingestAnalyticsBatch(request(batch(), "finalize-crash"), store, {
			secret,
			now: () => Date.parse("2026-01-02T00:00:00Z"),
		});
		const originalFinalize = store.finalizeCleanup.bind(store);
		let failed = true;
		store.finalizeCleanup = async (...args) => {
			if (failed) {
				failed = false;
				throw new Error("finalize failure");
			}
			return originalFinalize(...args);
		};
		const cutoffAt = Date.parse("2026-01-03T00:00:00Z");
		await expect(
			cleanupAnalytics(store, { default: 86_400_000 }, { cutoffAt, leaseNow: cutoffAt }),
		).rejects.toThrow("ANALYTICS_STORAGE_FINALIZE_FAILED");
		const receipt = await cleanupAnalytics(
			store,
			{ default: 86_400_000 },
			{ cutoffAt, leaseNow: cutoffAt + 2_000 },
		);
		expect(receipt.deleted).toBe(1);
		expect(receipt.id).toBe(
			(
				await cleanupAnalytics(
					store,
					{ default: 86_400_000 },
					{ cutoffAt, leaseNow: cutoffAt + 3_000 },
				)
			).id,
		);
	});
	it("does not retain raw identifiers in persisted rows, receipts, or exports", async () => {
		const store = new MemoryAnalyticsBackend();
		await ingestAnalyticsBatch(request(batch(), "privacy"), store, { secret, now: clock });
		const rows = await store.page(null, 10);
		const receipt = await cleanupAnalytics(
			store,
			{ default: 86_400_000 },
			Date.parse("2026-01-03T00:00:00Z"),
		);
		const serialized = JSON.stringify({
			rows,
			receipt,
			export: await exportAggregates(store, {
				from: Date.parse("2026-01-01T00:00:00Z"),
				to: Date.parse("2026-01-03T00:00:00Z"),
			}),
		});
		expect(serialized).not.toContain("anonymousId");
		expect(serialized).not.toContain("sessionId");
		expect(serialized).not.toContain('"path"');
		expect(serialized).not.toContain("payload");
		expect(serialized).not.toContain("e-page_view");
		expect(serialized).not.toContain("/lp");
		expect(serialized).not.toContain('"a"');
		expect(rows.rows[0]?.bodyHash ?? "").not.toBe(
			createHmac("sha256", "").update(JSON.stringify(batch())).digest("hex"),
		);
	});
	it("fails closed for empty, missing, fractional, and unsafe retention limits", () => {
		expect(() => validateRetention({})).toThrow();
		expect(() => validateRetention({ default: 86_400_000.5 })).toThrow();
		expect(() => validateRetention({ default: Number.NaN })).toThrow();
	});
	it("rejects invalid signature shapes independently", async () => {
		for (const signature of ["", "SHA256=bad", "00", "f".repeat(64).toUpperCase()]) {
			const result = await ingestAnalyticsBatch(
				request(batch(), signature, { "x-analytics-signature": signature }),
				new MemoryAnalyticsBackend(),
				{ secret, now: clock },
			);
			expect(result.status).toBe(401);
		}
	});
	it("maps verifier exceptions and backend creation failures to fail-closed responses", async () => {
		const unauthorized = await ingestAnalyticsBatch(
			request(batch()),
			new MemoryAnalyticsBackend(),
			{
				secret,
				now: clock,
				verify: () => {
					throw new Error("boom");
				},
			},
		);
		expect(unauthorized).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
		const failing = new MemoryAnalyticsBackend();
		failing.createIfAbsent = async () => {
			throw new Error("backend down");
		};
		expect(
			await ingestAnalyticsBatch(request(batch()), failing, { secret, now: clock }),
		).toMatchObject({ status: 503, body: { code: "ANALYTICS_STORAGE_CREATE_FAILED" } });
	});
	it("enforces bounded exact JSON reads and reader errors", async () => {
		const body = JSON.stringify(batch());
		const bodyRequest = new Request("https://x", {
			method: "POST",
			body,
			headers: { "content-length": String(body.length + 1) },
		});
		await expect(readBoundedJson(bodyRequest)).rejects.toThrow("BODY_LENGTH_MISMATCH");
	});
});
