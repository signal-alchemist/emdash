import { runInNewContext } from "node:vm";

import {
	serializeAnalyticsEventBatch,
	validateAnalyticsEventBatch,
} from "@signal-alchemist/marketing-automation-contracts";
import { describe, expect, it, vi } from "vitest";

import { analyticsPageFragments } from "../src/fragments.js";

const page = (overrides: Record<string, unknown> = {}) => ({
	url: "https://example.test/posts/hello",
	path: "/posts/hello",
	locale: "en",
	kind: "content" as const,
	pageType: "post",
	title: "Hello",
	description: null,
	canonical: null,
	image: null,
	content: { collection: "posts", id: "post-1", slug: "hello" },
	...overrides,
});

describe("analytics native page fragments", () => {
	const payloads = {
		page_view: {},
		section_exposure: { sectionId: "hero" },
		scroll_depth: { percent: 50 },
		cta_exposure: { elementId: "cta" },
		cta_click: { elementId: "cta" },
		form_start: { formId: "signup" },
		form_submit: { formId: "signup" },
		conversion: { conversionId: "lead" },
		revenue: { amount: 1, currency: "USD" },
		experiment_exposure: {},
	} as const;
	function boot(overrides: Record<string, unknown> = {}) {
		const code = (analyticsPageFragments(page(), { endpoint: "/collect" })[0] as { code: string })
			.code;
		const now = Date.now();
		let nextId = 0;
		const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, status: 202 }));
		const runtime: Record<string, unknown> = {
			__EMDASH_CONSENT__: () => ({
				state: "granted",
				policyVersion: 1,
				grantedAt: new Date(now - 1000).toISOString(),
				expiresAt: new Date(now + 86_400_000).toISOString(),
			}),
			__EMDASH_ANALYTICS_CONTEXT__: () => ({
				deploymentSha: "a".repeat(40),
				referrer: "/previous",
				experiment: {
					experimentId: "exp-1",
					variantId: "variant-a",
					assignedAt: new Date(now - 500).toISOString(),
				},
				campaign: { source: "newsletter" },
				viewport: { width: 1200, height: 800 },
			}),
			crypto: { randomUUID: vi.fn(() => `id-${++nextId}`) },
			fetch: fetchImpl,
			navigator: { sendBeacon: vi.fn(() => false) },
			setTimeout: vi.fn(() => 1),
			clearTimeout: vi.fn(),
			location: { pathname: "/posts/hello" },
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			TextEncoder,
			Blob,
			...overrides,
		};
		runtime.window = runtime;
		runInNewContext(code, runtime);
		return { runtime, fetchImpl };
	}
	async function flushBody(
		client: { flush: () => Promise<unknown> },
		fetchImpl: ReturnType<typeof vi.fn>,
	) {
		await client.flush();
		const call = fetchImpl.mock.calls.at(-1);
		expect(call).toBeDefined();
		const body = JSON.parse(
			String((call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).body),
		);
		return validateAnalyticsEventBatch(body, { now: Date.now() });
	}
	it("injects only a public non-preview inline client configuration", () => {
		const fragments = analyticsPageFragments(page(), { endpoint: "/collect" });
		expect(fragments).toHaveLength(1);
		expect(fragments[0]).toMatchObject({ kind: "inline-script", placement: "body:end" });
		expect((fragments[0] as { code: string }).code).toContain("post-1");
	});
	it("starts the self-contained client in a browser-like VM", async () => {
		const { runtime, fetchImpl } = boot();
		const client = runtime.__EMDASH_ANALYTICS_CLIENT__ as {
			context: { contentId: string };
			track: (name: string, payload: Record<string, unknown>) => void;
			flush: () => Promise<unknown>;
		};
		expect(client.context.contentId).toBe("post-1");
		for (const [name, payload] of Object.entries(payloads)) client.track(name, payload);
		client.track("scroll_depth", { percent: "PII" } as unknown as Record<string, unknown>);
		const batch = await flushBody(client, fetchImpl);
		expect(batch.events.map((event) => event.eventName)).toContain("experiment_exposure");
		expect(batch.events[0]?.contentId).toBe("post-1");
	});
	it("does not create browser state for denied consent", () => {
		const code = (analyticsPageFragments(page(), { endpoint: "/collect" })[0] as { code: string })
			.code;
		const randomUUID = vi.fn();
		const runtime: Record<string, unknown> = {
			__EMDASH_CONSENT__: () => ({ state: "denied", policyVersion: 1 }),
			crypto: { randomUUID },
			location: { pathname: "/posts/hello" },
		};
		runtime.window = runtime;
		runInNewContext(code, runtime);
		expect(runtime.__EMDASH_ANALYTICS_CLIENT__).toBeUndefined();
		expect(randomUUID).not.toHaveBeenCalled();
	});
	it("preserves residual queue bytes across a 20-event batch", async () => {
		const { runtime, fetchImpl } = boot();
		const client = runtime.__EMDASH_ANALYTICS_CLIENT__ as {
			track: (name: string, payload: Record<string, unknown>) => void;
			flush: () => Promise<unknown>;
		};
		for (let index = 0; index < 21; index++)
			client.track("section_exposure", { sectionId: `s-${index}` });
		await client.flush();
		await client.flush();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const first = JSON.parse(
			String(
				(fetchImpl.mock.calls[0] as unknown[])[1] &&
					((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body,
			),
		);
		const second = JSON.parse(
			String(
				(fetchImpl.mock.calls[1] as unknown[])[1] &&
					((fetchImpl.mock.calls[1] as unknown[])[1] as RequestInit).body,
			),
		);
		expect(first.events).toHaveLength(20);
		expect(second.events).toHaveLength(2);
	});
	it("falls back to fetch when pagehide beacon throws", async () => {
		const sendBeacon = vi.fn(() => {
			throw new Error("quota");
		});
		const { runtime, fetchImpl } = boot({ navigator: { sendBeacon } });
		const client = runtime.__EMDASH_ANALYTICS_CLIENT__ as {
			flush: (reason?: string) => Promise<unknown>;
		};
		const listeners = runtime.addEventListener as ReturnType<typeof vi.fn>;
		await client.flush("pagehide");
		expect(sendBeacon).toHaveBeenCalledOnce();
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(listeners).toHaveBeenCalledWith("pagehide", expect.any(Function));
	});
	it("coalesces concurrent VM flushes and drops permanent responses", async () => {
		let resolveFetch: ((value: { ok: boolean; status: number }) => void) | undefined;
		const fetchImpl = vi.fn(
			() =>
				new Promise<{ ok: boolean; status: number }>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const first = boot({ fetch: fetchImpl });
		const client = first.runtime.__EMDASH_ANALYTICS_CLIENT__ as { flush: () => Promise<unknown> };
		const one = client.flush();
		const two = client.flush();
		expect(one).toBe(two);
		expect(fetchImpl).toHaveBeenCalledOnce();
		resolveFetch?.({ ok: true, status: 202 });
		await one;

		const permanentFetch = vi.fn(() => Promise.resolve({ ok: false, status: 400 }));
		const permanent = boot({ fetch: permanentFetch });
		const permanentClient = permanent.runtime.__EMDASH_ANALYTICS_CLIENT__ as {
			flush: () => Promise<unknown>;
			droppedCount: () => number;
		};
		await permanentClient.flush();
		expect(permanentFetch).toHaveBeenCalledOnce();
		expect(permanentClient.droppedCount()).toBe(1);
	});
	it("settles and purges an in-flight retry when consent is withdrawn", async () => {
		let receipt: Record<string, unknown> = {
			state: "granted",
			policyVersion: 1,
			grantedAt: new Date(Date.now() - 1000).toISOString(),
			expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		};
		let notify: (() => void) | undefined;
		const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 503 }));
		const { runtime, fetchImpl: actualFetch } = boot({
			__EMDASH_CONSENT__: () => receipt,
			__EMDASH_CONSENT_SUBSCRIBE__: (listener: () => void) => {
				notify = listener;
				return vi.fn();
			},
			fetch: fetchImpl,
		});
		const client = runtime.__EMDASH_ANALYTICS_CLIENT__ as {
			flush: () => Promise<unknown>;
			context: { anonymousId: string; sessionId: string };
		};
		const pending = client.flush();
		receipt = { state: "withdrawn", policyVersion: 1 };
		notify?.();
		await pending;
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(actualFetch).not.toHaveBeenCalled();
		expect(client.context.anonymousId).toBe("");
		expect(client.context.sessionId).toBe("");
	});
	it("drops invalid source IDs and one-sided conversion payloads", async () => {
		const { runtime, fetchImpl } = boot({
			__EMDASH_ANALYTICS_CONTEXT__: () => ({ anonymousId: "free text", sessionId: "bad id" }),
		});
		const client = runtime.__EMDASH_ANALYTICS_CLIENT__ as {
			track: (name: string, payload: Record<string, unknown>) => void;
			flush: () => Promise<unknown>;
		};
		client.track("section_exposure", { sectionId: "free text" });
		client.track("conversion", { conversionId: "lead", value: 1 });
		await client.flush();
		const batch = await flushBody(client, fetchImpl);
		expect(batch.events).toHaveLength(1);
	});
	it("omits invalid optional context and requires experiment exposure context", async () => {
		const { runtime, fetchImpl } = boot({
			__EMDASH_ANALYTICS_CONTEXT__: () => ({
				deploymentSha: "NOT-A-SHA",
				viewport: { width: 0, height: 99999 },
				referrer: "https://evil.test/?token=x",
				experiment: { experimentId: "bad id", variantId: "bad id", assignedAt: "not-a-date" },
			}),
		});
		const client = runtime.__EMDASH_ANALYTICS_CLIENT__ as {
			context: Record<string, unknown>;
			track: (name: string, payload: Record<string, unknown>) => void;
			flush: () => Promise<unknown>;
		};
		expect(client.context.deploymentSha).toBeUndefined();
		expect(client.context.viewport).toBeUndefined();
		expect(client.context.referrer).toBeUndefined();
		client.track("experiment_exposure", {});
		await client.flush();
		const batch = await flushBody(client, fetchImpl);
		expect(batch.events).toHaveLength(1);
	});
	it("serializes the emitted batch with the shared deterministic serializer", async () => {
		const { runtime, fetchImpl } = boot();
		const client = runtime.__EMDASH_ANALYTICS_CLIENT__ as { flush: () => Promise<unknown> };
		await client.flush();
		const call = fetchImpl.mock.calls.at(-1);
		const body = String((call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).body);
		const parsed = JSON.parse(body);
		expect(serializeAnalyticsEventBatch(parsed, { now: Date.now() })).toBeTypeOf("string");
	});
	it.each(Object.entries(payloads))(
		"emits a validated %s event from the VM runtime",
		async (eventName, payload) => {
			const { runtime, fetchImpl } = boot();
			const client = runtime.__EMDASH_ANALYTICS_CLIENT__ as {
				track: (name: string, payload: Record<string, unknown>) => void;
				flush: () => Promise<unknown>;
			};
			client.track(eventName, payload);
			const batch = await flushBody(client, fetchImpl);
			expect(batch.events.some((event) => event.eventName === eventName)).toBe(true);
		},
	);
	it.each([
		["admin path", page({ path: "/_emdash/admin", url: "https://example.test/_emdash/admin" })],
		["preview query", page({ url: "https://example.test/posts/hello?preview=1" })],
		["draft page", page({ pageType: "draft" })],
		["mode preview", page({ url: "https://example.test/posts/hello?mode=preview" })],
	])("excludes %s", (_label, input) => {
		expect(analyticsPageFragments(input, { endpoint: "/collect" })).toEqual([]);
	});
	it("escapes script-breaking metadata and never emits credentials", () => {
		const fragments = analyticsPageFragments(
			page({ content: { collection: "posts", id: "</script><script>evil", slug: "x" } }),
			{ endpoint: "https://analytics.example.test/collect?token=secret" },
		);
		const code = (fragments[0] as { code: string }).code;
		expect(code).not.toContain("</script>");
		expect(code).not.toContain("token=secret");
	});
});

describe("analytics runtime security and serialization regressions", () => {
	const valid = (now: number) => ({
		state: "granted",
		policyVersion: 1,
		grantedAt: new Date(now - 1000).toISOString(),
		expiresAt: new Date(now + 86_400_000).toISOString(),
	});
	const code = () =>
		(analyticsPageFragments(page(), { endpoint: "/collect" })[0] as { code: string }).code;
	function vm(overrides: Record<string, unknown> = {}) {
		const now = Date.now();
		const consent = vi.fn(() => valid(now));
		const context = vi.fn(() => ({
			anonymousId: "anon",
			sessionId: "session",
			campaign: { source: "newsletter", medium: "email" },
			referrer: "/previous",
		}));
		const fetch = vi.fn(() => Promise.resolve({ ok: true, status: 202 }));
		const runtime: Record<string, any> = {
			__EMDASH_CONSENT__: consent,
			__EMDASH_ANALYTICS_CONTEXT__: context,
			crypto: { randomUUID: vi.fn(() => "event-1") },
			fetch,
			navigator: { sendBeacon: vi.fn(() => false) },
			setTimeout: vi.fn(() => 1),
			clearTimeout: vi.fn(),
			location: {
				pathname: "/posts/hello",
				href: "https://example.test/posts/hello",
				origin: "https://example.test",
			},
			document: { referrer: "" },
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			TextEncoder,
			Blob,
			URL,
			...overrides,
		};
		runtime.window = runtime;
		runInNewContext(code(), runtime);
		return { runtime, now, consent, context, fetch };
	}
	it("preserves global identity and has no side effects for excess consent", () => {
		const fetch = vi.fn();
		const consent = vi.fn(() => ({ ...valid(Date.now()), extra: true }));
		const context = vi.fn();
		const randomUUID = vi.fn();
		const addEventListener = vi.fn();
		const setTimeout = vi.fn();
		const subscribe = vi.fn();
		const sendBeacon = vi.fn();
		const runtime: Record<string, any> = {
			__EMDASH_CONSENT__: consent,
			__EMDASH_ANALYTICS_CONTEXT__: context,
			crypto: { randomUUID },
			fetch,
			addEventListener,
			setTimeout,
			__EMDASH_CONSENT_SUBSCRIBE__: subscribe,
			navigator: { sendBeacon },
			location: { pathname: "/" },
		};
		runtime.window = runtime;
		const fetchRef = runtime.fetch;
		const consentRef = runtime.__EMDASH_CONSENT__;
		const contextRef = runtime.__EMDASH_ANALYTICS_CONTEXT__;
		runInNewContext(code(), runtime);
		expect(runtime.fetch).toBe(fetchRef);
		expect(runtime.__EMDASH_CONSENT__).toBe(consentRef);
		expect(runtime.__EMDASH_ANALYTICS_CONTEXT__).toBe(contextRef);
		expect(runtime.__EMDASH_ANALYTICS_CLIENT__).toBeUndefined();
		expect(context).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(randomUUID).not.toHaveBeenCalled();
		expect(addEventListener).not.toHaveBeenCalled();
		expect(setTimeout).not.toHaveBeenCalled();
		expect(subscribe).not.toHaveBeenCalled();
		expect(sendBeacon).not.toHaveBeenCalled();
	});
	it("preserves global identity and has no side effects for invalid content", () => {
		const context = vi.fn();
		const fetch = vi.fn();
		const randomUUID = vi.fn();
		const addEventListener = vi.fn();
		const setTimeout = vi.fn();
		const subscribe = vi.fn();
		const sendBeacon = vi.fn();
		const bad = analyticsPageFragments(page({ content: { id: "<script>" } }), {
			endpoint: "/collect",
		});
		expect(bad).toHaveLength(1);
		const badRuntime: Record<string, any> = {
			__EMDASH_CONSENT__: () => valid(Date.now()),
			__EMDASH_ANALYTICS_CONTEXT__: context,
			crypto: { randomUUID },
			fetch,
			addEventListener,
			setTimeout,
			__EMDASH_CONSENT_SUBSCRIBE__: subscribe,
			navigator: { sendBeacon },
			location: { pathname: "/" },
		};
		badRuntime.window = badRuntime;
		runInNewContext((bad[0] as any).code, badRuntime);
		expect(badRuntime.__EMDASH_ANALYTICS_CLIENT__).toBeUndefined();
		expect(context).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(randomUUID).not.toHaveBeenCalled();
		expect(addEventListener).not.toHaveBeenCalled();
		expect(setTimeout).not.toHaveBeenCalled();
		expect(subscribe).not.toHaveBeenCalled();
		expect(sendBeacon).not.toHaveBeenCalled();
	});
	it("rejects null/custom/spoof prototypes and getters without invoking them", () => {
		let reads = 0;
		const candidate = Object.create({
			toString: Object.prototype.toString,
			hasOwnProperty: Object.prototype.hasOwnProperty,
		});
		Object.defineProperty(candidate, "anonymousId", {
			get: () => {
				reads++;
				return "anon";
			},
		});
		const { runtime, context } = vm({ __EMDASH_ANALYTICS_CONTEXT__: () => candidate });
		expect(runtime.__EMDASH_ANALYTICS_CLIENT__).toBeDefined();
		expect(reads).toBe(0);
		expect(context).not.toHaveBeenCalled();
		const nullProto = Object.create(null);
		Object.assign(nullProto, { anonymousId: "anon", sessionId: "session" });
		const result = vm({ __EMDASH_ANALYTICS_CONTEXT__: () => nullProto });
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__).toBeDefined();
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__.context.anonymousId).toMatch(/^event-/);
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__.context.sessionId).toMatch(/^event-/);
	});
	it("keeps valid campaign/referrer and omits invalid campaign wholly", async () => {
		const first = vm();
		const client = first.runtime.__EMDASH_ANALYTICS_CLIENT__;
		await client.flush();
		const body = JSON.parse(first.fetch.mock.calls[0][1].body);
		expect(body.events[0].campaign).toEqual({ source: "newsletter", medium: "email" });
		expect(body.events[0].referrer).toBe("/previous");
		expect(() => validateAnalyticsEventBatch(body, { now: Date.now() })).not.toThrow();
		const invalid = vm({
			__EMDASH_ANALYTICS_CONTEXT__: () => ({
				anonymousId: "anon",
				sessionId: "session",
				campaign: { source: "ok", extra: "drop" },
			}),
		});
		await invalid.runtime.__EMDASH_ANALYTICS_CLIENT__.flush();
		const invalidBody = JSON.parse(invalid.fetch.mock.calls[0][1].body);
		expect(invalidBody.events[0].campaign).toBeUndefined();
	});
	it("emits page_view but rejects experiment exposure for invalid timing", async () => {
		for (const assignedAt of [
			new Date(Date.now() - 86_400_000).toISOString(),
			new Date(Date.now() + 86_400_000).toISOString(),
		]) {
			const x = vm({
				__EMDASH_ANALYTICS_CONTEXT__: () => ({
					anonymousId: "anon",
					sessionId: "session",
					experiment: { experimentId: "exp", variantId: "v", assignedAt },
				}),
			});
			const c = x.runtime.__EMDASH_ANALYTICS_CLIENT__;
			c.track("experiment_exposure", {});
			await c.flush();
			const events = JSON.parse(x.fetch.mock.calls[0][1].body).events;
			expect(events.map((e: any) => e.eventName)).toEqual(["page_view"]);
		}
	});
	it("uses exact shared serialization for fetch and beacon, sorted by eventId", async () => {
		const x = vm({
			crypto: { randomUUID: vi.fn().mockReturnValueOnce("event-1").mockReturnValueOnce("event-2") },
		});
		const c = x.runtime.__EMDASH_ANALYTICS_CLIENT__;
		c.track("section_exposure", { sectionId: "b" });
		await c.flush();
		const text = x.fetch.mock.calls[0][1].body;
		const parsed = JSON.parse(text);
		expect(text).toBe(serializeAnalyticsEventBatch(parsed, { now: Date.now() }));
		expect(parsed.events.map((e: any) => e.eventId)).toEqual(
			parsed.events.map((e: any) => e.eventId).toSorted(),
		);
		const beacon = vi.fn(() => true);
		const y = vm({
			navigator: { sendBeacon: beacon },
			crypto: { randomUUID: vi.fn().mockReturnValue("beacon-1") },
		});
		y.runtime.__EMDASH_ANALYTICS_CLIENT__.flush("pagehide");
		await Promise.resolve();
		const blob = beacon.mock.calls[0][1];
		const blobText = await blob.text();
		expect(blobText).toBe(serializeAnalyticsEventBatch(JSON.parse(blobText), { now: Date.now() }));
	});
	it("rejects a non-enumerable context getter without reading it", () => {
		let reads = 0;
		const value = { anonymousId: "anon", sessionId: "session" };
		Object.defineProperty(value, "deploymentSha", {
			get: () => {
				reads++;
				return "a".repeat(40);
			},
			enumerable: false,
		});
		const result = vm({ __EMDASH_ANALYTICS_CONTEXT__: () => value });
		expect(reads).toBe(0);
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__).toBeDefined();
	});
	it("rejects an enumerable context getter without reading it", () => {
		let reads = 0;
		const value = { anonymousId: "anon", sessionId: "session" };
		Object.defineProperty(value, "deploymentSha", {
			get: () => {
				reads++;
				return "a".repeat(40);
			},
			enumerable: true,
		});
		const result = vm({ __EMDASH_ANALYTICS_CONTEXT__: () => value });
		expect(reads).toBe(0);
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__).toBeDefined();
	});
	it("rejects symbol-bearing context records", () => {
		const value = { anonymousId: "anon", sessionId: "session", [Symbol("pii")]: "secret" };
		const result = vm({ __EMDASH_ANALYTICS_CONTEXT__: () => value });
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__).toBeDefined();
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__.context.anonymousId).toMatch(/^event-/);
	});
	it("rejects an ordinary custom context prototype", () => {
		const value = Object.assign(Object.create({ inherited: true }), {
			anonymousId: "anon",
			sessionId: "session",
		});
		const result = vm({ __EMDASH_ANALYTICS_CONTEXT__: () => value });
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__.context.anonymousId).toMatch(/^event-/);
	});
	it("rejects a descriptor-copy Object.prototype spoof", () => {
		const spoof = Object.create(null);
		for (const key of Object.getOwnPropertyNames(Object.prototype))
			Object.defineProperty(spoof, key, Object.getOwnPropertyDescriptor(Object.prototype, key)!);
		const value = Object.assign(Object.create(spoof), {
			anonymousId: "anon",
			sessionId: "session",
		});
		const result = vm({ __EMDASH_ANALYTICS_CONTEXT__: () => value });
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__.context.anonymousId).toMatch(/^event-/);
	});
	it("accepts a cross-realm plain context record", () => {
		const result = vm();
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__.context.anonymousId).toBe("anon");
		expect(result.runtime.__EMDASH_ANALYTICS_CLIENT__.context.sessionId).toBe("session");
	});
	it("keeps consent, context, and fetch identities after destroy", () => {
		const result = vm();
		const client = result.runtime.__EMDASH_ANALYTICS_CLIENT__;
		const fetchRef = result.runtime.fetch;
		const consentRef = result.runtime.__EMDASH_CONSENT__;
		const contextRef = result.runtime.__EMDASH_ANALYTICS_CONTEXT__;
		client.destroy();
		expect(result.runtime.fetch).toBe(fetchRef);
		expect(result.runtime.__EMDASH_CONSENT__).toBe(consentRef);
		expect(result.runtime.__EMDASH_ANALYTICS_CONTEXT__).toBe(contextRef);
	});
	it("rejects experiment exposure before consent grant", async () => {
		const now = Date.now();
		const result = vm({
			__EMDASH_ANALYTICS_CONTEXT__: () => ({
				anonymousId: "anon",
				sessionId: "session",
				experiment: {
					experimentId: "exp",
					variantId: "v",
					assignedAt: new Date(now - 2000).toISOString(),
				},
			}),
			__EMDASH_CONSENT__: () => valid(now),
		});
		const client = result.runtime.__EMDASH_ANALYTICS_CLIENT__;
		client.track("experiment_exposure", {});
		await client.flush();
		expect(
			JSON.parse(result.fetch.mock.calls[0][1].body).events.map((event: any) => event.eventName),
		).toEqual(["page_view"]);
	});
	it("rejects experiment exposure exactly at expiry", async () => {
		const now = Date.now();
		const result = vm({
			__EMDASH_ANALYTICS_CONTEXT__: () => ({
				anonymousId: "anon",
				sessionId: "session",
				experiment: {
					experimentId: "exp",
					variantId: "v",
					assignedAt: new Date(now + 86_400_000).toISOString(),
				},
			}),
			__EMDASH_CONSENT__: () => valid(now),
		});
		const client = result.runtime.__EMDASH_ANALYTICS_CLIENT__;
		client.track("experiment_exposure", {});
		await client.flush();
		expect(
			JSON.parse(result.fetch.mock.calls[0][1].body).events.map((event: any) => event.eventName),
		).toEqual(["page_view"]);
	});
	it("rejects experiment exposure after expiry", async () => {
		const now = Date.now();
		const result = vm({
			__EMDASH_ANALYTICS_CONTEXT__: () => ({
				anonymousId: "anon",
				sessionId: "session",
				experiment: {
					experimentId: "exp",
					variantId: "v",
					assignedAt: new Date(now + 86_400_001).toISOString(),
				},
			}),
			__EMDASH_CONSENT__: () => valid(now),
		});
		const client = result.runtime.__EMDASH_ANALYTICS_CLIENT__;
		client.track("experiment_exposure", {});
		await client.flush();
		expect(
			JSON.parse(result.fetch.mock.calls[0][1].body).events.map((event: any) => event.eventName),
		).toEqual(["page_view"]);
	});
	it("rejects future experiment exposure", async () => {
		const now = Date.now();
		const result = vm({
			__EMDASH_ANALYTICS_CONTEXT__: () => ({
				anonymousId: "anon",
				sessionId: "session",
				experiment: {
					experimentId: "exp",
					variantId: "v",
					assignedAt: new Date(now + 300_000).toISOString(),
				},
			}),
			__EMDASH_CONSENT__: () => valid(now),
		});
		const client = result.runtime.__EMDASH_ANALYTICS_CLIENT__;
		client.track("experiment_exposure", {});
		await client.flush();
		expect(
			JSON.parse(result.fetch.mock.calls[0][1].body).events.map((event: any) => event.eventName),
		).toEqual(["page_view"]);
	});
});
