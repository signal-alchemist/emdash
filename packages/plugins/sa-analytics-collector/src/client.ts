import {
	serializeAnalyticsEventBatch,
	validateAnalyticsEventBatch,
	type AnalyticsConsentReceipt,
	type AnalyticsEventBatch,
	type AnalyticsEventName,
} from "@signal-alchemist/marketing-automation-contracts";

export type ClientEventName = AnalyticsEventName;
export type ConsentState = "granted" | "denied" | "withdrawn" | "unknown";
export interface ClientConsent {
	state: ConsentState;
	policyVersion: 1;
	grantedAt?: string;
	expiresAt?: string;
}
export interface ClientEventContext {
	anonymousId: string;
	sessionId: string;
	contentId?: string;
	deploymentSha?: string;
	experiment?: { experimentId: string; variantId: string; assignedAt: string };
	campaign?: Record<string, string | undefined>;
}
export interface AnalyticsClientOptions {
	endpoint: string;
	consent: ConsentSource;
	context: () => ClientEventContext;
	maxQueueEvents?: number;
	maxQueueBytes?: number;
	maxEventBytes?: number;
	maxBatchEvents?: number;
	maxBatchBytes?: number;
	flushIntervalMs?: number;
	maxAttempts?: number;
	retryDelayMs?: number;
	fetchImpl?: typeof fetch;
	onDrop?: (count: number, reason: string) => void;
}
export interface ConsentSource {
	(): ClientConsent;
	subscribe?: (listener: () => void) => () => void;
}
export type ClientPayloadByName = {
	page_view: Record<string, never>;
	section_exposure: { sectionId: string };
	scroll_depth: { percent: 25 | 50 | 75 | 90 | 100 };
	cta_exposure: { elementId: string };
	cta_click: { elementId: string };
	form_start: { formId: string };
	form_submit: { formId: string };
	conversion: { conversionId: string; value?: number; currency?: string };
	revenue: { amount: number; currency: string };
	experiment_exposure: Record<string, never>;
};
export interface AnalyticsClient {
	track<K extends ClientEventName>(eventName: K, payload: ClientPayloadByName[K]): void;
	flush(reason?: "manual" | "interval" | "batch-size" | "pagehide"): Promise<void>;
	destroy(): void;
	droppedCount(): number;
}

function browserAnalyticsRuntime(config: Record<string, unknown>): void {
	const root = globalThis as Record<string, any>;
	// eslint-disable-next-line unicorn/consistent-function-scoping
	const sorted = (values: any[], compare?: (left: any, right: any) => number): any[] => {
		const copy = values.slice();
		// oxlint-disable-next-line unicorn(no-array-sort), e18e(prefer-array-to-sorted) -- ES2022 browser target.
		copy.sort(compare);
		return copy;
	};
	// oxlint-disable-next-line e18e(prefer-static-regex), unicorn(consistent-function-scoping) -- this runtime is stringified for browser injection and must remain self-contained.
	// eslint-disable-next-line e18e/prefer-static-regex
	const ID = new RegExp("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
	// oxlint-disable-next-line e18e(prefer-static-regex), unicorn(consistent-function-scoping) -- this runtime is stringified for browser injection and must remain self-contained.
	// eslint-disable-next-line e18e/prefer-static-regex
	const SHA = new RegExp("^[a-f0-9]{40}$");
	// oxlint-disable-next-line e18e(prefer-static-regex), unicorn(consistent-function-scoping) -- this runtime is stringified for browser injection and must remain self-contained.
	// eslint-disable-next-line e18e/prefer-static-regex
	const ISO = new RegExp("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$");
	const names = new Set([
		"page_view",
		"section_exposure",
		"scroll_depth",
		"cta_exposure",
		"cta_click",
		"form_start",
		"form_submit",
		"conversion",
		"revenue",
		"experiment_exposure",
	]);
	const keys: Record<string, string[]> = {
		page_view: [],
		section_exposure: ["sectionId"],
		scroll_depth: ["percent"],
		cta_exposure: ["elementId"],
		cta_click: ["elementId"],
		form_start: ["formId"],
		form_submit: ["formId"],
		conversion: ["conversionId", "value", "currency"],
		revenue: ["amount", "currency"],
		experiment_exposure: [],
	};
	const required: Record<string, string[]> = {
		page_view: [],
		section_exposure: ["sectionId"],
		scroll_depth: ["percent"],
		cta_exposure: ["elementId"],
		cta_click: ["elementId"],
		form_start: ["formId"],
		form_submit: ["formId"],
		conversion: ["conversionId"],
		revenue: ["amount", "currency"],
		experiment_exposure: [],
	};
	// eslint-disable-next-line unicorn/consistent-function-scoping
	const text = (v: unknown, max = 256): v is string =>
		typeof v === "string" &&
		v.length > 0 &&
		v.length <= max &&
		!Array.from(v, (c) => c.charCodeAt(0)).some((code) => code < 32);
	// eslint-disable-next-line unicorn/consistent-function-scoping
	const isObjectPrototype = (p: any) => {
		if (!p || Object.getPrototypeOf(p) !== null || p.constructor?.prototype !== p) return false;
		const prototypeNames = sorted(Object.getOwnPropertyNames(Object.prototype)) as string[];
		const actual = sorted(Object.getOwnPropertyNames(p)) as string[];
		if (prototypeNames.length !== actual.length || prototypeNames.some((n, i) => n !== actual[i]))
			return false;
		for (const n of prototypeNames) {
			const a = Object.getOwnPropertyDescriptor(Object.prototype, n);
			const b = Object.getOwnPropertyDescriptor(p, n);
			if (
				!a ||
				!b ||
				a.enumerable !== b.enumerable ||
				a.configurable !== b.configurable ||
				a.writable !== b.writable ||
				(typeof a.value === "function" && typeof b.value !== "function")
			)
				return false;
		}
		return (
			Function.prototype.toString.call(p.toString) ===
				Function.prototype.toString.call(Object.prototype.toString) &&
			Function.prototype.toString.call(p.constructor) === Function.prototype.toString.call(Object)
		);
	};
	const exact = (v: unknown, allowed: string[]): v is Record<string, any> => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return false;
		const p = Object.getPrototypeOf(v);
		if (!isObjectPrototype(p)) return false;
		return Reflect.ownKeys(v).every(
			(key) =>
				typeof key === "string" &&
				allowed.includes(key) &&
				key !== "__proto__" &&
				key !== "constructor" &&
				key !== "prototype" &&
				Object.getOwnPropertyDescriptor(v, key)?.get === undefined &&
				Object.getOwnPropertyDescriptor(v, key)?.set === undefined,
		);
	};
	const iso = (v: unknown): v is string =>
		typeof v === "string" &&
		ISO.test(v) &&
		!Number.isNaN(Date.parse(v)) &&
		new Date(v).toISOString() === v;
	// eslint-disable-next-line unicorn/consistent-function-scoping
	const stable = (v: any): string =>
		Array.isArray(v)
			? `[${v.map(stable).join(",")}]`
			: v && typeof v === "object"
				? `{${sorted(Object.keys(v).filter((k) => v[k] !== undefined))
						.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
						.join(",")}}`
				: JSON.stringify(v);
	// eslint-disable-next-line unicorn/consistent-function-scoping
	const now = () => Date.now();
	const consent = () => {
		try {
			return typeof root.__EMDASH_CONSENT__ === "function" ? root.__EMDASH_CONSENT__() : null;
		} catch {
			return null;
		}
	};
	const eligible = (r: any) =>
		!!r &&
		exact(r, ["state", "policyVersion", "grantedAt", "expiresAt"]) &&
		r.state === "granted" &&
		r.policyVersion === 1 &&
		iso(r.grantedAt) &&
		iso(r.expiresAt) &&
		Date.parse(r.grantedAt) <= now() &&
		Date.parse(r.expiresAt) > now() &&
		Date.parse(r.expiresAt) - Date.parse(r.grantedAt) <= 31 * 86400000;
	const bootConsent = consent();
	if (config.enabled === false || !ID.test(config.contentId as string) || !eligible(bootConsent))
		return;
	let candidate: unknown = {};
	try {
		candidate =
			typeof root.__EMDASH_ANALYTICS_CONTEXT__ === "function"
				? root.__EMDASH_ANALYTICS_CONTEXT__()
				: {};
	} catch {
		candidate = {};
	}
	const allowedContext = [
		"anonymousId",
		"sessionId",
		"contentId",
		"deploymentSha",
		"viewport",
		"campaign",
		"experiment",
		"referrer",
	];
	const raw = exact(candidate, allowedContext) ? candidate : {};
	const anonymousId = ID.test(raw.anonymousId || "")
		? raw.anonymousId
		: root.crypto?.randomUUID?.();
	const sessionId = ID.test(raw.sessionId || "") ? raw.sessionId : root.crypto?.randomUUID?.();
	if (!ID.test(anonymousId || "") || !ID.test(sessionId || "")) return;
	const context: Record<string, any> = { anonymousId, sessionId, contentId: config.contentId };
	if (raw.deploymentSha !== undefined && SHA.test(raw.deploymentSha))
		context.deploymentSha = raw.deploymentSha;
	if (
		raw.viewport !== undefined &&
		exact(raw.viewport, ["width", "height"]) &&
		Number.isSafeInteger(raw.viewport.width) &&
		Number.isSafeInteger(raw.viewport.height) &&
		raw.viewport.width >= 1 &&
		raw.viewport.height >= 1 &&
		raw.viewport.width <= 10000 &&
		raw.viewport.height <= 10000
	)
		context.viewport = { width: raw.viewport.width, height: raw.viewport.height };
	if (
		raw.campaign !== undefined &&
		exact(raw.campaign, ["source", "medium", "campaign", "term", "content", "clickId"])
	) {
		const c: Record<string, string> = {};
		let validCampaign = true;
		for (const k of ["source", "medium", "campaign", "term", "content", "clickId"])
			if (raw.campaign[k] !== undefined) {
				if (!text(raw.campaign[k])) validCampaign = false;
				else c[k] = raw.campaign[k];
			}
		if (validCampaign) context.campaign = c;
	}
	if (
		raw.experiment !== undefined &&
		exact(raw.experiment, ["experimentId", "variantId", "assignedAt"]) &&
		ID.test(raw.experiment.experimentId) &&
		ID.test(raw.experiment.variantId) &&
		iso(raw.experiment.assignedAt) &&
		Date.parse(raw.experiment.assignedAt) >= Date.parse(bootConsent.grantedAt) &&
		Date.parse(raw.experiment.assignedAt) < Date.parse(bootConsent.expiresAt) &&
		Date.parse(raw.experiment.assignedAt) <= now()
	)
		context.experiment = {
			experimentId: raw.experiment.experimentId,
			variantId: raw.experiment.variantId,
			assignedAt: raw.experiment.assignedAt,
		};
	const location = root.location || root.window?.location;
	// eslint-disable-next-line unicorn/consistent-function-scoping
	const safePath = (value: unknown) =>
		typeof value === "string" &&
		value.startsWith("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@") &&
		!Array.from(value, (c) => c.charCodeAt(0)).some((code) => code < 32) &&
		!value
			.split("/")
			.slice(1)
			.some((s) => !s || s === "." || s === "..");
	const path = safePath(location?.pathname) ? location.pathname : "/";
	const queue: any[] = [];
	let queueBytes = 0,
		dropped = 0,
		destroyed = false,
		timer: any,
		retryTimer: any,
		retryResolve: (() => void) | undefined,
		flushing: Promise<void> | undefined;
	const maxQueue = Number.isSafeInteger(config.maxQueueEvents)
		? (config.maxQueueEvents as number)
		: 100;
	const maxQueueBytes = Number.isSafeInteger(config.maxQueueBytes)
		? (config.maxQueueBytes as number)
		: 64000;
	const maxEvent = Number.isSafeInteger(config.maxEventBytes)
		? (config.maxEventBytes as number)
		: 8192;
	const maxBatch = Number.isSafeInteger(config.maxBatchEvents)
		? (config.maxBatchEvents as number)
		: 20;
	const maxBatchBytes = Number.isSafeInteger(config.maxBatchBytes)
		? (config.maxBatchBytes as number)
		: 64000;
	const interval = Number.isSafeInteger(config.flushIntervalMs)
		? (config.flushIntervalMs as number)
		: 5000;
	const attempts = Number.isSafeInteger(config.maxAttempts) ? (config.maxAttempts as number) : 3;
	const delay = Number.isSafeInteger(config.retryDelayMs) ? (config.retryDelayMs as number) : 250;
	const drop = (n: number, reason: string) => {
		dropped += n;
		if (typeof config.onDrop === "function") config.onDrop(n, reason);
	};
	const clear = () => {
		queue.length = 0;
		queueBytes = 0;
		if (timer !== undefined) root.clearTimeout?.(timer);
		if (retryTimer !== undefined) root.clearTimeout?.(retryTimer);
		retryResolve?.();
		timer = retryTimer = undefined;
		retryResolve = undefined;
		context.anonymousId = "";
		context.sessionId = "";
	};
	let unsubscribe: (() => void) | undefined;
	const remove = () => {
		root.removeEventListener?.("pagehide", onPageHide);
		unsubscribe?.();
		unsubscribe = undefined;
	};
	const revoke = () => {
		clear();
		remove();
	};
	const validPayload = (name: string, payload: any) =>
		names.has(name) &&
		exact(payload, keys[name] || []) &&
		(required[name] || []).every((k) => payload[k] !== undefined) &&
		["sectionId", "elementId", "formId", "conversionId"].every(
			(k) => payload[k] === undefined || ID.test(payload[k]),
		) &&
		(name !== "scroll_depth" || [25, 50, 75, 90, 100].includes(payload.percent)) &&
		["value", "amount"].every(
			(k) =>
				payload[k] === undefined ||
				(Number.isSafeInteger(payload[k]) && payload[k] >= 0 && payload[k] <= 1000000000),
		) &&
		(payload.currency === undefined ||
			// oxlint-disable-next-line e18e(prefer-static-regex), unicorn(consistent-function-scoping) -- this runtime is stringified for browser injection and must remain self-contained.
			new RegExp("^[A-Z]{3}$").test(payload.currency)) && // eslint-disable-line e18e/prefer-static-regex
		(name !== "conversion" || (payload.value === undefined) === (payload.currency === undefined)) &&
		(name !== "experiment_exposure" || !!context.experiment);
	const normalize = (name: string, payload: any) => {
		if (!validPayload(name, payload)) return null;
		const r = consent();
		const occurredAt = new Date().toISOString();
		const e: any = {
			version: 1,
			eventId: root.crypto?.randomUUID?.(),
			eventName: name,
			occurredAt,
			anonymousId: context.anonymousId,
			sessionId: context.sessionId,
			path,
			contentId: context.contentId,
			payload: { ...payload },
		};
		if (
			!ID.test(e.eventId || "") ||
			!eligible(r) ||
			Date.parse(occurredAt) < Date.parse(r.grantedAt) ||
			Date.parse(occurredAt) >= Date.parse(r.expiresAt)
		)
			return null;
		if (
			context.experiment &&
			(Date.parse(context.experiment.assignedAt) < Date.parse(r.grantedAt) ||
				Date.parse(context.experiment.assignedAt) >= Date.parse(r.expiresAt) ||
				Date.parse(context.experiment.assignedAt) > Date.parse(occurredAt))
		)
			return null;
		if (context.deploymentSha) e.deploymentSha = context.deploymentSha;
		if (context.viewport) e.viewport = context.viewport;
		if (context.campaign) e.campaign = context.campaign;
		if (context.experiment) e.experiment = context.experiment;
		const referrer = raw.referrer || root.document?.referrer;
		if (
			referrer &&
			typeof referrer === "string" &&
			!referrer.includes("\\") &&
			!referrer.includes("?") &&
			!referrer.includes("#") &&
			!referrer.includes("@") &&
			!Array.from(referrer, (c) => c.charCodeAt(0)).some((code) => code < 32)
		) {
			try {
				const u = new URL(referrer, location?.href || "https://invalid.local/");
				if (u.origin === (location?.origin || u.origin) && safePath(u.pathname))
					e.referrer = u.pathname;
			} catch {}
		}
		return e;
	};
	const send = async (body: string, reason: string): Promise<boolean> => {
		if (!eligible(consent()) || destroyed) return true;
		if (reason === "pagehide" && root.navigator?.sendBeacon) {
			try {
				if (
					root.navigator.sendBeacon(
						config.endpoint,
						new root.Blob([body], { type: "application/json" }),
					)
				)
					return true;
			} catch {}
		}
		const response = await root.fetch(config.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			credentials: "same-origin",
			keepalive: reason === "pagehide",
		});
		if (response.ok) return true;
		if (
			response.status >= 400 &&
			response.status < 500 &&
			![408, 425, 429].includes(response.status)
		)
			return false;
		throw new Error("TRANSIENT");
	};
	const flush = (reason = "manual"): Promise<void> => {
		if (flushing) return flushing;
		if (!eligible(consent()) || destroyed || !queue.length) {
			if (!eligible(consent())) revoke();
			return Promise.resolve();
		}
		const r = consent();
		const receipt = {
			state: "granted",
			policyVersion: 1,
			grantedAt: r.grantedAt,
			expiresAt: r.expiresAt,
		};
		const events = queue.splice(0, maxBatch);
		const body = stable({
			version: 1,
			consent: receipt,
			events: sorted(events, (a, b) =>
				a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0,
			),
		});
		queueBytes = Math.max(
			0,
			queueBytes -
				events.reduce((n, e) => n + new root.TextEncoder().encode(stable(e)).byteLength, 0),
		);
		if (new root.TextEncoder().encode(body).byteLength > maxBatchBytes) {
			drop(events.length, "batch_bytes");
			return Promise.resolve();
		}
		flushing = (async () => {
			for (let attempt = 1; attempt <= attempts; attempt++) {
				if (!eligible(consent()) || destroyed) return;
				try {
					if (await send(body, reason)) return;
					drop(events.length, "permanent");
					return;
				} catch {
					if (attempt === attempts) {
						drop(events.length, "retry_exhausted");
						return;
					}
					if (!eligible(consent()) || destroyed) return;
					await new Promise<void>((resolve) => {
						retryResolve = resolve;
						retryTimer = root.setTimeout(
							() => {
								retryTimer = undefined;
								retryResolve = undefined;
								resolve();
							},
							delay * 2 ** (attempt - 1),
						);
					});
				}
			}
		})().finally(() => {
			flushing = undefined;
			if (!destroyed && queue.length && eligible(consent())) schedule();
		});
		return flushing;
	};
	const schedule = () => {
		if (timer === undefined && queue.length && eligible(consent()))
			timer = root.setTimeout(() => {
				timer = undefined;
				void flush("interval");
			}, interval);
	};
	const onPageHide = () => {
		if (eligible(consent())) void flush("pagehide");
		else revoke();
	};
	const client: any = {
		context,
		track: (name: string, payload: any) => {
			if (destroyed || !eligible(consent())) {
				if (!eligible(consent())) revoke();
				return;
			}
			const event = normalize(name, payload);
			if (!event) return;
			const bytes = new root.TextEncoder().encode(stable(event)).byteLength;
			if (bytes > maxEvent) {
				drop(1, "event_bytes");
				return;
			}
			while (queue.length >= maxQueue || queueBytes + bytes > maxQueueBytes) {
				const old = queue.shift();
				if (!old) break;
				queueBytes -= new root.TextEncoder().encode(stable(old)).byteLength;
				drop(1, "queue_overflow");
			}
			queue.push(event);
			queueBytes += bytes;
			if (queue.length >= maxBatch) void flush("batch-size");
			else schedule();
		},
		flush,
		destroy: () => {
			if (destroyed) return;
			destroyed = true;
			clear();
			remove();
		},
		droppedCount: () => dropped,
	};
	root.addEventListener?.("pagehide", onPageHide);
	if (typeof root.__EMDASH_CONSENT_SUBSCRIBE__ === "function")
		unsubscribe = root.__EMDASH_CONSENT_SUBSCRIBE__(() => {
			if (!eligible(consent())) revoke();
		});
	root.__EMDASH_ANALYTICS_CLIENT__ = client;
	client.track("page_view", {});
}

export function createAnalyticsClientBootstrap(config: string): string {
	return `(${browserAnalyticsRuntime.toString()})(${config});`;
}

type QueuedEvent = AnalyticsEventBatch["events"][number];
const TRANSIENT = new Set([408, 425, 429]);
const CONSENT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
function sortedStrings(values: string[]): string[] {
	const copy = values.slice();
	// oxlint-disable-next-line unicorn(no-array-sort), e18e(prefer-array-to-sorted) -- ES2022 package target.
	copy.sort();
	return copy;
}

function exactConsent(value: unknown): value is ClientConsent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (
		!prototype ||
		Object.getPrototypeOf(prototype) !== null ||
		prototype.constructor?.prototype !== prototype
	)
		return false;
	const names = sortedStrings(Object.getOwnPropertyNames(Object.prototype));
	const actual = sortedStrings(Object.getOwnPropertyNames(prototype));
	if (names.length !== actual.length || names.some((name, index) => name !== actual[index]))
		return false;
	for (const name of names) {
		const expected = Object.getOwnPropertyDescriptor(Object.prototype, name);
		const received = Object.getOwnPropertyDescriptor(prototype, name);
		if (
			!expected ||
			!received ||
			expected.enumerable !== received.enumerable ||
			expected.configurable !== received.configurable ||
			expected.writable !== received.writable ||
			(typeof expected.value === "function" && typeof received.value !== "function")
		)
			return false;
	}
	if (
		Function.prototype.toString.call(prototype.toString) !==
			Function.prototype.toString.call(Object.prototype.toString) ||
		Function.prototype.toString.call(prototype.constructor) !==
			Function.prototype.toString.call(Object)
	)
		return false;
	const allowed = new Set(["state", "policyVersion", "grantedAt", "expiresAt"]);
	return Reflect.ownKeys(value).every((key) => {
		if (typeof key !== "string" || !allowed.has(key)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor?.get === undefined && descriptor?.set === undefined;
	});
}

function browserWindow(): Window | undefined {
	return typeof window === "undefined" ? undefined : window;
}
function safeEndpoint(endpoint: string): boolean {
	if (endpoint.startsWith("/")) {
		const unsafe = Array.from(endpoint, (character) => ({ character, code: character.charCodeAt(0) })).some(
			({ character, code }) => code < 32 || character === "<" || character === ">",
		);
		return !endpoint.startsWith("//") && !unsafe;
	}
	return false;
}
function normalizeReferrer(referrer: string, location: Location): string | undefined {
	try {
		const url = new URL(referrer, location.href);
		if (url.origin !== location.origin) return undefined;
		const path = url.pathname;
		if (
			!path.startsWith("/") ||
			path.startsWith("//") ||
			path
				.split("/")
				.slice(1)
				.some((part) => !part || part === "." || part === "..")
		)
			return undefined;
		return path;
	} catch {
		return undefined;
	}
}
function bounded(value: number | undefined, fallback: number, max: number): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max)
		throw new Error("ANALYTICS_OPTION_INVALID");
	return resolved;
}
function validConsent(
	receipt: ClientConsent,
	now: number,
): receipt is ClientConsent & { state: "granted"; grantedAt: string; expiresAt: string } {
	if (!exactConsent(receipt)) return false;
	if (
		receipt.state !== "granted" ||
		receipt.policyVersion !== 1 ||
		!receipt.grantedAt ||
		!receipt.expiresAt
	)
		return false;
	if (
		!CONSENT_ISO.test(receipt.grantedAt) ||
		!CONSENT_ISO.test(receipt.expiresAt) ||
		new Date(receipt.grantedAt).toISOString() !== receipt.grantedAt ||
		new Date(receipt.expiresAt).toISOString() !== receipt.expiresAt
	)
		return false;
	const granted = Date.parse(receipt.grantedAt);
	const expires = Date.parse(receipt.expiresAt);
	return (
		Number.isFinite(granted) &&
		Number.isFinite(expires) &&
		granted <= now &&
		expires > now &&
		expires > granted &&
		expires - granted <= 31 * 24 * 60 * 60 * 1000
	);
}

export function createAnalyticsClient(options: AnalyticsClientOptions): AnalyticsClient {
	const maxQueueEvents = bounded(options.maxQueueEvents, 100, 1000);
	const maxQueueBytes = bounded(options.maxQueueBytes, 64_000, 1_000_000);
	const maxEventBytes = bounded(options.maxEventBytes, 8_192, maxQueueBytes);
	const maxBatchEvents = bounded(options.maxBatchEvents, 20, 100);
	const maxBatchBytes = bounded(options.maxBatchBytes, 64_000, 1_000_000);
	const interval = bounded(options.flushIntervalMs, 5_000, 86_400_000);
	const maxAttempts = bounded(options.maxAttempts, 3, 5);
	const retryDelay = bounded(options.retryDelayMs, 1_000, 60_000);
	const fetchImpl = options.fetchImpl ?? fetch;
	const queue: QueuedEvent[] = [];
	let queueBytes = 0;
	let timer: number | undefined;
	let retryTimer: number | undefined;
	let retryResolve: (() => void) | undefined;
	let unsubscribeConsent: (() => void) | undefined;
	let listenerInstalled = false;
	let destroyed = false;
	let flushing: Promise<void> | undefined;
	let dropped = 0;
	const drop = (count: number, reason: string) => {
		dropped += count;
		options.onDrop?.(count, reason.slice(0, 32));
	};
	const clearQueue = () => {
		queue.length = 0;
		queueBytes = 0;
	};
	const readConsent = (): ClientConsent => {
		try {
			return options.consent();
		} catch {
			return { state: "unknown", policyVersion: 1 };
		}
	};
	const revoke = () => {
		clearQueue();
		const w = browserWindow();
		if (timer !== undefined) w?.clearTimeout(timer);
		if (retryTimer !== undefined) w?.clearTimeout(retryTimer);
		retryResolve?.();
		retryResolve = undefined;
		timer = undefined;
		retryTimer = undefined;
	};
	const enabled = () => !destroyed && validConsent(readConsent(), Date.now());
	const removeListener = () => {
		if (!listenerInstalled) return;
		browserWindow()?.removeEventListener("pagehide", onPageHide);
		listenerInstalled = false;
		unsubscribeConsent?.();
		unsubscribeConsent = undefined;
	};
	const schedule = () => {
		const w = browserWindow();
		if (!w || timer !== undefined || queue.length === 0 || !enabled()) return;
		timer = w.setTimeout(() => {
			timer = undefined;
			void flush("interval");
		}, interval);
	};
	const installListener = () => {
		const w = browserWindow();
		if (!w || listenerInstalled || !enabled()) return;
		w.addEventListener("pagehide", onPageHide);
		listenerInstalled = true;
		unsubscribeConsent = options.consent.subscribe?.(() => {
			if (!enabled()) {
				revoke();
				removeListener();
			}
		});
	};
	const send = async (body: string, reason: string): Promise<boolean> => {
		if (!enabled()) return true;
		if (reason === "pagehide" && typeof navigator !== "undefined" && navigator.sendBeacon) {
			if (navigator.sendBeacon(options.endpoint, new Blob([body], { type: "application/json" })))
				return true;
		}
		const response = await fetchImpl(options.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			keepalive: reason === "pagehide",
			credentials: "same-origin",
		});
		if (response.ok) return true;
		if (TRANSIENT.has(response.status) || response.status >= 500) throw new Error("TRANSIENT");
		return false;
	};
	const flush = async (
		reason: "manual" | "interval" | "batch-size" | "pagehide" = "manual",
	): Promise<void> => {
		if (flushing) return flushing;
		if (!enabled() || queue.length === 0) {
			if (!enabled()) {
				revoke();
				removeListener();
			}
			return;
		}
		const receipt = readConsent();
		const events = queue.splice(0, maxBatchEvents);
		const batch = { version: 1 as const, consent: receipt as AnalyticsConsentReceipt, events };
		let body: string;
		try {
			body = serializeAnalyticsEventBatch(batch, { now: new Date().toISOString() });
		} catch {
			drop(events.length, "invalid_batch");
			return;
		}
		const bodyBytes = new TextEncoder().encode(body).byteLength;
		const eventBytes = events.reduce(
			(total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
			0,
		);
		queueBytes = Math.max(0, queueBytes - eventBytes);
		if (bodyBytes > maxBatchBytes) {
			drop(events.length, "batch_bytes");
			return;
		}
		flushing = (async () => {
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				if (!enabled()) {
					drop(events.length, "withdrawn");
					return;
				}
				try {
					if (await send(body, reason)) return;
					drop(events.length, "permanent");
					return;
				} catch {
					if (attempt === maxAttempts) {
						drop(events.length, "retry_exhausted");
						return;
					}
					await new Promise<void>((resolve) => {
						const w = browserWindow();
						if (!w) return resolve();
						retryResolve = resolve;
						retryTimer = w.setTimeout(
							() => {
								retryTimer = undefined;
								retryResolve = undefined;
								resolve();
							},
							retryDelay * 2 ** (attempt - 1),
						);
					});
				}
			}
		})().finally(() => {
			flushing = undefined;
			if (enabled() && queue.length > 0) schedule();
		});
		return flushing;
	};
	function onPageHide() {
		if (enabled()) void flush("pagehide");
		else revoke();
	}
	if (!safeEndpoint(options.endpoint)) throw new Error("ANALYTICS_ENDPOINT_INVALID");
	return {
		track(eventName, payload) {
			if (!enabled()) {
				revoke();
				removeListener();
				return;
			}
			const w = browserWindow();
			if (!w) return;
			installListener();
			const currentConsent = readConsent();
			const context = options.context();
			const event = {
				version: 1 as const,
				eventId: crypto.randomUUID(),
				eventName,
				occurredAt: new Date().toISOString(),
				anonymousId: context.anonymousId,
				sessionId: context.sessionId,
				path: w.location.pathname,
				referrer: document.referrer ? normalizeReferrer(document.referrer, w.location) : undefined,
				viewport: { width: w.innerWidth, height: w.innerHeight },
				contentId: context.contentId,
				deploymentSha: context.deploymentSha,
				campaign: context.campaign,
				experiment: context.experiment,
				payload,
			};
			try {
				const normalized = validateAnalyticsEventBatch(
					{ version: 1, consent: currentConsent as AnalyticsConsentReceipt, events: [event] },
					{ now: new Date().toISOString() },
				);
				const normalizedEvent = normalized.events[0];
				if (!normalizedEvent) throw new Error("ANALYTICS_EVENT_EMPTY");
				const bytes = new TextEncoder().encode(JSON.stringify(normalizedEvent)).byteLength;
				if (bytes > maxEventBytes) {
					drop(1, "event_bytes");
					return;
				}
				while (queue.length >= maxQueueEvents || queueBytes + bytes > maxQueueBytes) {
					if (!queue.length) break;
					const removed = queue.shift();
					queueBytes -= removed ? new TextEncoder().encode(JSON.stringify(removed)).byteLength : 0;
					drop(1, "queue_overflow");
				}
				if (queueBytes + bytes > maxQueueBytes) {
					drop(1, "queue_overflow");
					return;
				}
				queue.push(normalizedEvent);
				queueBytes += bytes;
				if (queue.length >= maxBatchEvents) void flush("batch-size");
				else schedule();
				return;
			} catch {
				drop(1, "invalid_event");
				return;
			}
		},
		flush,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			revoke();
			removeListener();
		},
		droppedCount: () => dropped,
	};
}
