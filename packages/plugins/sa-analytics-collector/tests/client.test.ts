import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnalyticsClient } from "../src/client.js";

function installBrowser() {
	const listeners = new Map<string, Set<() => void>>();
	const windowStub = {
		location: { pathname: "/landing" },
		innerWidth: 1200,
		innerHeight: 800,
		addEventListener: vi.fn((name: string, handler: () => void) => {
			const set = listeners.get(name) ?? new Set<() => void>();
			set.add(handler);
			listeners.set(name, set);
		}),
		removeEventListener: vi.fn(),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
	};
	Object.assign(globalThis, { window: windowStub, document: { referrer: "" }, Blob });
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: { randomUUID: vi.fn(() => "event-1") },
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { sendBeacon: vi.fn(() => true) },
	});
	return { windowStub, listeners };
}

function grantedConsent() {
	const now = Date.now();
	return {
		state: "granted" as const,
		policyVersion: 1 as const,
		grantedAt: new Date(now - 60_000).toISOString(),
		expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).window;
	delete (globalThis as Record<string, unknown>).document;
	delete (globalThis as Record<string, unknown>).navigator;
});

describe("consent-gated analytics client", () => {
	it("has zero browser side effects and does not call context before consent", () => {
		const { windowStub } = installBrowser();
		const context = vi.fn(() => ({ anonymousId: "anon", sessionId: "session" }));
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: () => ({ state: "unknown", policyVersion: 1 }),
			context,
		});

		client.track("page_view", {});

		expect(context).not.toHaveBeenCalled();
		expect(windowStub.addEventListener).not.toHaveBeenCalled();
		expect(windowStub.setTimeout).not.toHaveBeenCalled();
	});
	it("validates and forwards a typed event only after grant", async () => {
		const { windowStub } = installBrowser();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
			fetchImpl,
		});
		client.track("page_view", {});
		await client.flush();
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string).consent.state).toBe("granted");
		expect(windowStub.addEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
	});
	it.each(["email", "formValue", "html", "replay", "screenshot", "cookie", "authorization"])(
		"rejects forbidden payload key %s before queueing",
		(key) => {
			installBrowser();
			const onDrop = vi.fn();
			const client = createAnalyticsClient({
				endpoint: "/collect",
				consent: grantedConsent,
				context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
				onDrop,
			});
			client.track("page_view", { nested: { [key]: "secret" } });
			expect(onDrop).toHaveBeenCalledWith(1, "invalid_event");
		},
	);
	it("withdrawal purges queue and prevents network activity", async () => {
		installBrowser();
		let current = grantedConsent();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: () => current,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
			fetchImpl,
		});
		client.track("page_view", {});
		current = { ...current, state: "withdrawn" };
		await client.flush();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(client.droppedCount()).toBe(0);
	});
	it("drops invalid consent states without identifiers or listeners", () => {
		const { windowStub } = installBrowser();
		const randomUUID = crypto.randomUUID;
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: () => ({ state: "denied", policyVersion: 1 }),
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
		});
		client.track("page_view", {});
		expect(randomUUID).not.toHaveBeenCalled();
		expect(windowStub.addEventListener).not.toHaveBeenCalled();
	});
	it("bounds queue count with deterministic oldest-drop behavior", () => {
		installBrowser();
		const onDrop = vi.fn();
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
			maxQueueEvents: 1,
			maxBatchEvents: 10,
			onDrop,
		});
		client.track("page_view", {});
		client.track("page_view", {});
		expect(onDrop).toHaveBeenCalledWith(1, "queue_overflow");
	});
	it("bounds each event before it enters the queue", async () => {
		installBrowser();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
		const onDrop = vi.fn();
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
			maxEventBytes: 100,
			fetchImpl,
			onDrop,
		});
		client.track("section_exposure", { sectionId: "x".repeat(100) });
		await client.flush();
		expect(onDrop).toHaveBeenCalledWith(1, "event_bytes");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("bounds total queue bytes and drops the oldest event", async () => {
		installBrowser();
		let nextId = 0;
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { randomUUID: vi.fn(() => `event-${nextId++}`) },
		});
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
		const onDrop = vi.fn();
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
			maxQueueBytes: 5000,
			maxEventBytes: 5000,
			maxBatchEvents: 100,
			fetchImpl,
			onDrop,
		});
		for (let index = 0; index < 30; index++)
			client.track("section_exposure", { sectionId: `event-${index}` });
		await client.flush();
		const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
		expect(body.events.length).toBeGreaterThan(0);
		expect(body.events.some((event: any) => event.payload.sectionId === "event-0")).toBe(false);
		expect(body.events.some((event: any) => event.payload.sectionId === "event-29")).toBe(true);
		expect(
			onDrop.mock.calls.filter(([count, reason]) => count === 1 && reason === "queue_overflow")
				.length,
		).toBeGreaterThan(0);
	});
	it("drops an oversized batch before beacon or fetch", async () => {
		installBrowser();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
		const beacon = navigator.sendBeacon as ReturnType<typeof vi.fn>;
		const onDrop = vi.fn();
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
			maxBatchBytes: 1,
			fetchImpl,
			onDrop,
		});
		client.track("page_view", {});
		await client.flush("pagehide");
		expect(onDrop).toHaveBeenCalledWith(1, "batch_bytes");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(beacon).not.toHaveBeenCalled();
	});
	it("rejects unrestricted and unsafe endpoints", () => {
		installBrowser();
		const base = { consent: grantedConsent, context: () => ({ anonymousId: "a", sessionId: "s" }) };
		expect(() => createAnalyticsClient({ ...base, endpoint: "javascript:alert(1)" })).toThrow(
			"ANALYTICS_ENDPOINT_INVALID",
		);
		expect(() => createAnalyticsClient({ ...base, endpoint: "//evil.example/collect" })).toThrow(
			"ANALYTICS_ENDPOINT_INVALID",
		);
	});
	it("destroy is idempotent and removes pagehide listener", () => {
		const { windowStub } = installBrowser();
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
		});
		client.track("page_view", {});
		client.destroy();
		client.destroy();
		expect(windowStub.removeEventListener).toHaveBeenCalledOnce();
	});
	it("rechecks consent and uses bounded pagehide beacon", async () => {
		const { listeners } = installBrowser();
		const beacon = navigator.sendBeacon as ReturnType<typeof vi.fn>;
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
		});
		client.track("page_view", {});
		listeners.get("pagehide")?.forEach((handler) => handler());
		await Promise.resolve();
		expect(beacon).toHaveBeenCalledOnce();
	});
	it("drops permanent responses and caps transient attempts", async () => {
		installBrowser();
		const onDrop = vi.fn();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
			maxAttempts: 1,
			fetchImpl,
			onDrop,
		});
		client.track("page_view", {});
		await client.flush();
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(onDrop).toHaveBeenCalledWith(1, "retry_exhausted");
	});
	it("coalesces concurrent flush calls", async () => {
		installBrowser();
		let resolveFetch!: () => void;
		const fetchImpl = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = () => resolve(new Response(null, { status: 202 }));
				}),
		);
		const client = createAnalyticsClient({
			endpoint: "/collect",
			consent: grantedConsent,
			context: () => ({ anonymousId: "anon-1", sessionId: "session-1" }),
			fetchImpl,
		});
		client.track("page_view", {});
		const first = client.flush();
		const second = client.flush();
		resolveFetch();
		await Promise.all([first, second]);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});
});
