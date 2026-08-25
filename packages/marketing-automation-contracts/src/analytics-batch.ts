import type { AnalyticsEventEnvelope, AnalyticsEventName } from "./index.js";
import { validateAnalyticsEventEnvelope } from "./validators.js";

export type ConsentState = "granted" | "denied" | "withdrawn";
export interface AnalyticsConsentReceipt {
	state: ConsentState;
	policyVersion: 1;
	grantedAt: string;
	expiresAt: string;
}
export interface AnalyticsEventBatch {
	version: 1;
	consent: AnalyticsConsentReceipt;
	events: NormalizedAnalyticsEvent[];
}
type AnalyticsPayloadByName = {
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
export type NormalizedAnalyticsEvent = {
	[K in AnalyticsEventName]: AnalyticsEventEnvelope<AnalyticsPayloadByName[K]> & { eventName: K };
}[AnalyticsEventName];
export const MAX_MONEY_MINOR = 10_000_000_00;

const MAX_EVENTS = 100;
const MAX_BYTES = 64_000;
const MAX_STRING = 256;
const MAX_VALIDITY_MS = 31 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ZERO_MILLIS = /\.000Z$/;
function fail(code: string): never {
	throw new AnalyticsBatchValidationError(code);
}

export class AnalyticsBatchValidationError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "AnalyticsBatchValidationError";
		this.code = code;
	}
}
function text(value: unknown, code: string): string {
	if (typeof value !== "string" || !value || value.length > MAX_STRING) fail(code);
	return value;
}
function exact(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype) fail(`${code}_PROTOTYPE`);
	const input = Object.fromEntries(Object.entries(value));
	const allowed = new Set(keys);
	for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}_EXCESS_FIELD`);
	return input;
}
function iso(value: unknown, code: string): string {
	const output = text(value, code);
	const parsed = Date.parse(output);
	const canonical = Number.isNaN(parsed)
		? ""
		: new Date(parsed).toISOString().replace(ZERO_MILLIS, output.endsWith(".000Z") ? ".000Z" : "Z");
	if (!RFC3339_UTC.test(output) || Number.isNaN(parsed) || canonical !== output) fail(code);
	return output;
}
function id(value: unknown, code: string): string {
	const output = text(value, code);
	if (!ID.test(output)) fail(code);
	return output;
}
function eventPayload(eventName: AnalyticsEventName, value: unknown): Record<string, unknown> {
	const keys: Record<AnalyticsEventName, string[]> = {
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
	const payload = exact(value, keys[eventName], `ANALYTICS_${eventName.toUpperCase()}_PAYLOAD`);
	const required: Record<AnalyticsEventName, string[]> = {
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
	for (const key of required[eventName])
		if (payload[key] === undefined)
			fail(`ANALYTICS_${eventName.toUpperCase()}_${key.toUpperCase()}_REQUIRED`);
	if (
		["section_exposure", "cta_exposure", "cta_click", "form_start", "form_submit"].includes(
			eventName,
		) &&
		Object.keys(payload).length === 0
	)
		fail(`ANALYTICS_${eventName.toUpperCase()}_PAYLOAD_REQUIRED`);
	if (eventName === "revenue" && (payload.amount === undefined || payload.currency === undefined))
		fail("ANALYTICS_REVENUE_MONEY_REQUIRED");
	if (
		eventName === "conversion" &&
		(payload.value === undefined) !== (payload.currency === undefined)
	)
		fail("ANALYTICS_CONVERSION_MONEY_PAIR_REQUIRED");
	for (const key of ["sectionId", "elementId", "formId", "conversionId"])
		if (payload[key] !== undefined)
			id(payload[key], `ANALYTICS_${eventName.toUpperCase()}_${key.toUpperCase()}_INVALID`);
	if (eventName === "scroll_depth") {
		if (typeof payload.percent !== "number" || ![25, 50, 75, 90, 100].includes(payload.percent))
			fail("ANALYTICS_SCROLL_DEPTH_INVALID");
	}
	for (const key of ["value", "amount"])
		if (
			payload[key] !== undefined &&
			(typeof payload[key] !== "number" ||
				!Number.isFinite(payload[key]) ||
				payload[key] < 0 ||
				!Number.isSafeInteger(payload[key]) ||
				payload[key] > MAX_MONEY_MINOR)
		)
			fail("ANALYTICS_MONEY_INVALID");
	if (
		payload.currency !== undefined &&
		!CURRENCY.test(text(payload.currency, "ANALYTICS_CURRENCY_INVALID"))
	)
		fail("ANALYTICS_CURRENCY_INVALID");
	if (
		payload.amount !== undefined &&
		(typeof payload.amount !== "number" || payload.amount > Number.MAX_SAFE_INTEGER)
	)
		fail("ANALYTICS_MONEY_INVALID");
	return payload;
}
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.fromEntries(Object.entries(value));
		return `{${orderKeys(Object.keys(entries))
			.map((key) => `${JSON.stringify(key)}:${stable(entries[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
function compareAscii(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}
function orderKeys(keys: string[]): string[] {
	const copy = [...keys];
	// oxlint-disable-next-line unicorn(no-array-sort), e18e(prefer-array-to-sorted) -- ES2022 runtime compatibility
	copy.sort(compareAscii);
	return copy;
}
function orderEvents(events: NormalizedAnalyticsEvent[]): NormalizedAnalyticsEvent[] {
	const copy = [...events];
	// oxlint-disable-next-line unicorn(no-array-sort), e18e(prefer-array-to-sorted) -- ES2022 runtime compatibility
	copy.sort((a, b) => compareAscii(a.eventId, b.eventId));
	return copy;
}
export interface AnalyticsBatchValidationOptions {
	now: string | number;
}
export function validateAnalyticsEventBatch(
	value: unknown,
	options: AnalyticsBatchValidationOptions,
): AnalyticsEventBatch {
	const input = exact(value, ["version", "consent", "events"], "ANALYTICS_BATCH");
	if (input.version !== 1) fail("ANALYTICS_BATCH_VERSION_UNSUPPORTED");
	const consent = exact(
		input.consent,
		["state", "policyVersion", "grantedAt", "expiresAt"],
		"ANALYTICS_CONSENT",
	);
	if (consent.state !== "granted" || consent.policyVersion !== 1)
		fail("ANALYTICS_CONSENT_NOT_ELIGIBLE");
	const grantedAt = iso(consent.grantedAt, "ANALYTICS_CONSENT_GRANTED_AT_INVALID");
	const expiresAt = iso(consent.expiresAt, "ANALYTICS_CONSENT_EXPIRES_AT_INVALID");
	const optionsInput = exact(options, ["now"], "ANALYTICS_NOW_INVALID");
	const nowValue = optionsInput.now;
	const now =
		typeof nowValue === "number" ? nowValue : Date.parse(iso(nowValue, "ANALYTICS_NOW_INVALID"));
	if (!Number.isSafeInteger(now) || now < 0 || now > 4102444800000) fail("ANALYTICS_NOW_INVALID");
	if (
		Date.parse(grantedAt) > now ||
		Date.parse(expiresAt) <= Date.parse(grantedAt) ||
		Date.parse(expiresAt) - Date.parse(grantedAt) > MAX_VALIDITY_MS ||
		Date.parse(expiresAt) <= now
	)
		fail("ANALYTICS_CONSENT_EXPIRED");
	if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > MAX_EVENTS)
		fail("ANALYTICS_BATCH_COUNT_INVALID");
	const ids = new Set<string>();
	const events = input.events.map((raw: unknown) => {
		const rawObject = exact(
			raw,
			[
				"version",
				"eventId",
				"eventName",
				"occurredAt",
				"receivedAt",
				"anonymousId",
				"sessionId",
				"path",
				"referrer",
				"contentId",
				"deploymentSha",
				"viewport",
				"campaign",
				"experiment",
				"payload",
			],
			"ANALYTICS_EVENT",
		);
		const payloadValue = rawObject.payload;
		if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue))
			fail("ANALYTICS_EVENT_PAYLOAD_INVALID");
		if (Object.getPrototypeOf(payloadValue) !== Object.prototype)
			fail("ANALYTICS_EVENT_PAYLOAD_PROTOTYPE");
		const event = validateAnalyticsEventEnvelope(raw);
		iso(event.occurredAt, "ANALYTICS_EVENT_OCCURRED_AT_INVALID");
		if (event.receivedAt !== undefined) iso(event.receivedAt, "ANALYTICS_RECEIVED_AT_INVALID");
		id(event.eventId, "ANALYTICS_EVENT_ID_INVALID");
		id(event.anonymousId, "ANALYTICS_ANONYMOUS_ID_INVALID");
		id(event.sessionId, "ANALYTICS_SESSION_ID_INVALID");
		if (event.contentId !== undefined) id(event.contentId, "ANALYTICS_CONTENT_ID_INVALID");
		if (event.viewport !== undefined) {
			if (
				!Number.isSafeInteger(event.viewport.width) ||
				!Number.isSafeInteger(event.viewport.height) ||
				event.viewport.width < 1 ||
				event.viewport.height < 1 ||
				event.viewport.width > 10000 ||
				event.viewport.height > 10000
			)
				fail("ANALYTICS_VIEWPORT_INVALID");
		}
		if (event.experiment !== undefined) {
			id(event.experiment.experimentId, "ANALYTICS_EXPERIMENT_ID_INVALID");
			id(event.experiment.variantId, "ANALYTICS_VARIANT_ID_INVALID");
			iso(event.experiment.assignedAt, "ANALYTICS_ASSIGNED_AT_INVALID");
			if (
				Date.parse(event.experiment.assignedAt) < Date.parse(grantedAt) ||
				Date.parse(event.experiment.assignedAt) >= Date.parse(expiresAt) ||
				Date.parse(event.experiment.assignedAt) > Date.parse(event.occurredAt) ||
				Date.parse(event.experiment.assignedAt) > now + 300000
			)
				fail("ANALYTICS_ASSIGNED_AT_INVALID");
		}
		if (
			event.referrer !== undefined &&
			(!event.referrer.startsWith("/") ||
				event.referrer.startsWith("//") ||
				event.referrer.includes("\\") ||
				event.referrer
					.split("/")
					.slice(1)
					.some((segment) => !segment || segment === "." || segment === "..") ||
				event.referrer.includes("?") ||
				event.referrer.includes("#") ||
				event.referrer.includes("@") ||
				Array.from(event.referrer, (char) => char.charCodeAt(0)).some((code) => code < 32))
		)
			fail("ANALYTICS_REFERRER_INVALID");
		if (
			Date.parse(event.occurredAt) < Date.parse(grantedAt) ||
			Date.parse(event.occurredAt) >= Date.parse(expiresAt) ||
			Date.parse(event.occurredAt) > now + 300000
		)
			fail("ANALYTICS_EVENT_TIME_INVALID");
		if (
			event.receivedAt !== undefined &&
			(Date.parse(event.receivedAt) < Date.parse(event.occurredAt) ||
				Date.parse(event.receivedAt) > now + 300000 ||
				Date.parse(event.receivedAt) >= Date.parse(expiresAt))
		)
			fail("ANALYTICS_RECEIVED_AT_INVALID");
		if (ids.has(event.eventId)) fail("ANALYTICS_BATCH_DUPLICATE_EVENT_ID");
		ids.add(event.eventId);
		if (event.eventName === "experiment_exposure" && !event.experiment)
			fail("ANALYTICS_EXPERIMENT_REQUIRED");
		const payload = eventPayload(event.eventName, event.payload);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the envelope and event-specific payload have both passed runtime validation above.
		return { ...event, eventName: event.eventName, payload } as NormalizedAnalyticsEvent;
	});
	const normalized = {
		version: 1 as const,
		consent: { state: "granted" as const, policyVersion: 1 as const, grantedAt, expiresAt },
		events: orderEvents(events),
	};
	if (new TextEncoder().encode(stable(normalized)).byteLength > MAX_BYTES)
		fail("ANALYTICS_BATCH_BYTES_INVALID");
	return structuredClone(normalized);
}
export function serializeAnalyticsEventBatch(
	value: AnalyticsEventBatch,
	options: AnalyticsBatchValidationOptions,
): string {
	const normalized = validateAnalyticsEventBatch(value, options);
	return stable(normalized);
}
