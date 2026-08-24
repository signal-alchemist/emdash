import { describe, expect, it } from "vitest";

import {
	serializeAnalyticsEventBatch as serializeBatch,
	validateAnalyticsEventBatch as validateBatch,
	MAX_MONEY_MINOR,
} from "../src/index.js";
import type { NormalizedAnalyticsEvent } from "../src/index.js";

const NOW = { now: "2026-01-02T12:00:00Z" };
const validateAnalyticsEventBatch = (value: unknown) => validateBatch(value, NOW);
const serializeAnalyticsEventBatch = (value: any) => serializeBatch(value, NOW);

const consent = {
	state: "granted" as const,
	policyVersion: 1 as const,
	grantedAt: "2026-01-01T00:00:00Z",
	expiresAt: "2026-01-10T00:00:00Z",
};
const event = (eventName: string, payload: Record<string, unknown> = {}) => ({
	version: 1,
	eventId: `event-${eventName}`,
	eventName,
	occurredAt: "2026-01-02T00:00:00Z",
	anonymousId: "anon-1",
	sessionId: "session-1",
	path: "/lp",
	payload,
});
const batch = (events = [event("page_view")]) => ({ version: 1, consent: { ...consent }, events });

describe("consent-aware analytics batches", () => {
	it.each([
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
	])("accepts event type %s", (name) => {
		const payload =
			name === "section_exposure"
				? { sectionId: "hero" }
				: name === "scroll_depth"
					? { percent: 50 }
					: name === "cta_exposure" || name === "cta_click"
						? { elementId: "cta" }
						: name === "form_start" || name === "form_submit"
							? { formId: "signup" }
							: name === "revenue"
								? { amount: 10, currency: "USD" }
								: name === "conversion"
									? { conversionId: "lead", value: 10, currency: "USD" }
									: {};
		const input = batch([event(name, payload)]);
		if (name === "experiment_exposure")
			(input.events[0] as Record<string, unknown>).experiment = {
				experimentId: "exp",
				variantId: "a",
				assignedAt: "2026-01-02T00:00:00Z",
			};
		expect(validateAnalyticsEventBatch(input).events).toHaveLength(1);
	});
	it.each(["denied", "withdrawn"])("rejects consent state %s", (state) =>
		expect(() =>
			validateAnalyticsEventBatch({ ...batch(), consent: { ...consent, state } }),
		).toThrow("ANALYTICS_CONSENT_NOT_ELIGIBLE"),
	);
	it.each([
		["section_exposure", {}],
		["scroll_depth", {}],
		["cta_exposure", {}],
		["cta_click", {}],
		["form_start", {}],
		["form_submit", {}],
		["conversion", {}],
		["revenue", {}],
	])("rejects missing event-specific fields for %s", (name, payload) =>
		expect(() => validateAnalyticsEventBatch(batch([event(name, payload)]))).toThrow(),
	);
	it("rejects invalid money representations and unpaired conversion money", () => {
		expect(() =>
			validateAnalyticsEventBatch(batch([event("revenue", { amount: 1.5, currency: "USD" })])),
		).toThrow("ANALYTICS_MONEY_INVALID");
		expect(() =>
			validateAnalyticsEventBatch(batch([event("revenue", { amount: 1, currency: "usd" })])),
		).toThrow("ANALYTICS_CURRENCY_INVALID");
		expect(() =>
			validateAnalyticsEventBatch(batch([event("conversion", { conversionId: "c", value: 1 })])),
		).toThrow("ANALYTICS_CONVERSION_MONEY_PAIR_REQUIRED");
	});
	it.each([
		[
			"future grant",
			{ ...consent, grantedAt: "2026-01-03T00:00:00Z" },
			"ANALYTICS_CONSENT_EXPIRED",
		],
		[
			"long validity",
			{ ...consent, expiresAt: "2026-03-01T00:00:00Z" },
			"ANALYTICS_CONSENT_EXPIRED",
		],
		["invalid now", consent, "ANALYTICS_NOW_INVALID"],
	])("rejects consent timing %s", (_label, receipt, code) =>
		expect(() =>
			validateBatch(
				{ ...batch(), consent: receipt },
				{ now: _label === "invalid now" ? Number.NaN : "2026-01-02T00:00:00Z" },
			),
		).toThrow(code),
	);
	it("rejects event timestamps outside consent and skew window", () => {
		expect(() =>
			validateBatch(
				{ ...batch([event("page_view")]), events: [event("page_view")] },
				{ now: "2026-01-02T00:00:00Z" },
			),
		).not.toThrow();
		expect(() =>
			validateBatch(
				{
					...batch([event("page_view")]),
					events: [{ ...event("page_view"), occurredAt: "2025-12-31T00:00:00Z" }],
				},
				NOW,
			),
		).toThrow("ANALYTICS_EVENT_TIME_INVALID");
		expect(() =>
			validateBatch(
				{
					...batch([event("page_view")]),
					events: [{ ...event("page_view"), occurredAt: "2026-01-02T13:00:00Z" }],
				},
				NOW,
			),
		).toThrow("ANALYTICS_EVENT_TIME_INVALID");
	});
	it.each(["batch", "consent", "event", "payload"])("rejects custom prototype at %s", (place) => {
		const value = batch();
		if (place === "batch") Object.setPrototypeOf(value, null);
		if (place === "consent") Object.setPrototypeOf(value.consent, null);
		if (place === "event") Object.setPrototypeOf(value.events[0], null);
		if (place === "payload") Object.setPrototypeOf(value.events[0].payload, null);
		expect(() => validateAnalyticsEventBatch(value)).toThrow();
	});
	it("rejects expired, duplicate, excess, PII, malformed, and invalid scroll input", () => {
		expect(() =>
			validateAnalyticsEventBatch({
				...batch(),
				consent: { ...consent, expiresAt: "2020-01-01T00:00:00Z" },
			}),
		).toThrow("ANALYTICS_CONSENT_EXPIRED");
		expect(() =>
			validateAnalyticsEventBatch(batch([event("page_view"), event("page_view")])),
		).toThrow("ANALYTICS_BATCH_DUPLICATE_EVENT_ID");
		expect(() => validateAnalyticsEventBatch(batch([event("page_view", { extra: true })]))).toThrow(
			"ANALYTICS_PAGE_VIEW_PAYLOAD_EXCESS_FIELD",
		);
		expect(() =>
			validateAnalyticsEventBatch(batch([event("page_view", { nested: { email: "x" } })])),
		).toThrow("SECURITY_FORBIDDEN_KEY");
		expect(() =>
			validateAnalyticsEventBatch(batch([event("scroll_depth", { percent: 33 })])),
		).toThrow("ANALYTICS_SCROLL_DEPTH_INVALID");
	});
	it("sorts events and keys deterministically without mutating input", () => {
		const input = batch([
			event("page_view"),
			{ ...event("cta_click", { elementId: "cta" }), eventId: "event-aaa" },
		]);
		const before = JSON.stringify(input);
		const output = serializeAnalyticsEventBatch(input);
		expect(output).toBe(
			serializeAnalyticsEventBatch({ ...input, events: input.events.toReversed() }),
		);
		expect(JSON.stringify(input)).toBe(before);
	});
	it.each([undefined, null, [], "text"])(
		"rejects malformed payload with a typed error",
		(payload) =>
			expect(() =>
				validateBatch({ ...batch(), events: [{ ...event("page_view"), payload }] }, NOW),
			).toThrow("ANALYTICS_EVENT_PAYLOAD_INVALID"),
	);
	it("rejects omitted and invalid validation time, including expiry equality", () => {
		expect(() => validateBatch(batch(), undefined as never)).toThrow("ANALYTICS_NOW_INVALID");
		expect(() => validateBatch(batch(), { now: Number.NaN })).toThrow("ANALYTICS_NOW_INVALID");
		expect(() =>
			validateBatch(
				{ ...batch(), consent: { ...consent, expiresAt: "2026-01-02T12:00:00Z" } },
				NOW,
			),
		).toThrow("ANALYTICS_CONSENT_EXPIRED");
	});
	it("rejects zero and over-limit batch counts", () => {
		expect(() => validateBatch(batch([]), NOW)).toThrow("ANALYTICS_BATCH_COUNT_INVALID");
		expect(() =>
			validateBatch(batch(Array.from({ length: 101 }, (_, i) => event(`e-${i}`))), NOW),
		).toThrow("ANALYTICS_BATCH_COUNT_INVALID");
	});
	it("rejects serialized batch over byte limit", () => {
		const events = Array.from({ length: 100 }, (_, i) => ({
			...event("page_view"),
			eventId: `event-${i}`,
			path: `/${"a".repeat(1000)}`,
		}));
		expect(() => validateBatch({ ...batch(events), events }, NOW)).toThrow(
			"ANALYTICS_BATCH_BYTES_INVALID",
		);
	});
	it("rejects unsafe referrers", () => {
		for (const referrer of ["//evil", "/a\\b", "/a/../b", "/a//b", "/a?x", "/a#x", "/a\u0000b"])
			expect(() =>
				validateBatch({ ...batch(), events: [{ ...event("page_view"), referrer }] }, NOW),
			).toThrow("ANALYTICS_REFERRER_INVALID");
	});
	it("accepts safe origin-relative referrer", () => {
		expect(
			validateBatch(
				{ ...batch(), events: [{ ...event("page_view"), referrer: "/from/home" }] },
				NOW,
			).events[0]?.referrer,
		).toBe("/from/home");
	});
	it("rejects invalid receivedAt ordering", () => {
		for (const receivedAt of [
			"2026-01-01T23:00:00Z",
			"2026-01-10T00:00:00Z",
			"2026-01-02T13:00:01Z",
			"not-a-date",
		])
			expect(() =>
				validateBatch({ ...batch(), events: [{ ...event("page_view"), receivedAt }] }, NOW),
			).toThrow();
	});
	it("enforces bounded money maximum", () => {
		expect(
			validateBatch(batch([event("revenue", { amount: 0, currency: "USD" })]), NOW),
		).toBeTruthy();
		expect(
			validateBatch(batch([event("revenue", { amount: MAX_MONEY_MINOR, currency: "USD" })]), NOW),
		).toBeTruthy();
		expect(() =>
			validateBatch(
				batch([event("revenue", { amount: MAX_MONEY_MINOR + 1, currency: "USD" })]),
				NOW,
			),
		).toThrow();
	});
	it("rejects privacy fields independently", () => {
		for (const key of [
			"formValue",
			"email",
			"phone",
			"cookie",
			"authorization",
			"html",
			"DOM",
			"replay",
			"screenshot",
		])
			expect(() =>
				validateBatch(
					{ ...batch(), events: [{ ...event("page_view"), payload: { nested: { [key]: "x" } } }] },
					NOW,
				),
			).toThrow();
	});
	it("rejects uppercase deployment SHA and malformed identifiers", () => {
		expect(() =>
			validateBatch(
				{
					...batch(),
					events: [
						{ ...event("page_view"), deploymentSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" },
					],
				},
				NOW,
			),
		).toThrow();
		expect(() =>
			validateBatch({ ...batch(), events: [{ ...event("page_view"), contentId: "bad id" }] }, NOW),
		).toThrow();
	});
	it.each([
		["page_view", { extra: true }],
		["section_exposure", { sectionId: "hero", extra: true }],
		["scroll_depth", { percent: 50, extra: true }],
		["cta_exposure", { elementId: "cta", extra: true }],
		["cta_click", { elementId: "cta", extra: true }],
		["form_start", { formId: "signup", extra: true }],
		["form_submit", { formId: "signup", extra: true }],
		["conversion", { conversionId: "lead", extra: true }],
		["revenue", { amount: 1, currency: "USD", extra: true }],
		["experiment_exposure", { extra: true }],
	])("rejects excess payload fields for %s", (name, payload) => {
		const current = event(name, payload);
		if (name === "experiment_exposure")
			(current as Record<string, unknown>).experiment = {
				experimentId: "exp",
				variantId: "a",
				assignedAt: "2026-01-02T00:00:00Z",
			};
		expect(() => validateAnalyticsEventBatch(batch([current]))).toThrow();
	});
	it.each([
		["page_view", { extra: true }],
		["section_exposure", { sectionId: "" }],
		["scroll_depth", { percent: "50" }],
		["cta_exposure", { elementId: "" }],
		["cta_click", { elementId: "" }],
		["form_start", { formId: "" }],
		["form_submit", { formId: "" }],
		["conversion", { conversionId: "" }],
		["revenue", { amount: -1, currency: "USD" }],
		["experiment_exposure", {}],
	])("rejects invalid or missing payload for %s", (name, payload) => {
		const current = event(name, payload);
		if (name === "experiment_exposure" && Object.keys(payload).length > 0)
			(current as Record<string, unknown>).experiment = {
				experimentId: "exp",
				variantId: "a",
				assignedAt: "2026-01-02T00:00:00Z",
			};
		expect(() => validateAnalyticsEventBatch(batch([current]))).toThrow();
	});
	it.each([
		["2026-01-02", "ANALYTICS_CONSENT_GRANTED_AT_INVALID"],
		["2026-01-02T00:00:00+00:00", "ANALYTICS_CONSENT_GRANTED_AT_INVALID"],
		["2026-02-30T00:00:00Z", "ANALYTICS_CONSENT_GRANTED_AT_INVALID"],
	])("rejects non-canonical consent timestamp %s", (timestamp, code) => {
		expect(() =>
			validateBatch({ ...batch(), consent: { ...consent, grantedAt: timestamp } }, NOW),
		).toThrow(code);
	});
	it("requires exact validation options and safe numeric now", () => {
		expect(() => validateBatch(batch(), { now: NOW.now, extra: true } as never)).toThrow(
			"ANALYTICS_NOW_INVALID_EXCESS_FIELD",
		);
		expect(() => validateBatch(batch(), { now: 1.5 })).toThrow("ANALYTICS_NOW_INVALID");
		expect(() => validateBatch(batch(), { now: Infinity })).toThrow("ANALYTICS_NOW_INVALID");
	});
	it("checks experiment assignment against consent and occurrence", () => {
		const current = event("experiment_exposure");
		(current as Record<string, unknown>).experiment = {
			experimentId: "exp",
			variantId: "a",
			assignedAt: "2026-01-02T00:00:01Z",
		};
		expect(() => validateAnalyticsEventBatch(batch([current]))).toThrow(
			"ANALYTICS_ASSIGNED_AT_INVALID",
		);
	});
	it("rejects viewport bounds and campaign excess fields", () => {
		for (const viewport of [
			{ width: 0, height: 100 },
			{ width: 10001, height: 100 },
			{ width: 1.5, height: 100 },
		])
			expect(() =>
				validateBatch({ ...batch(), events: [{ ...event("page_view"), viewport }] }, NOW),
			).toThrow();
		expect(() =>
			validateBatch(
				{ ...batch(), events: [{ ...event("page_view"), campaign: { source: "x", extra: "y" } }] },
				NOW,
			),
		).toThrow();
	});
	it("rejects forbidden prototype keys and cycles without raw errors", () => {
		for (const key of ["__proto__", "constructor", "prototype"]) {
			const payload = { nested: { [key]: "x" } };
			expect(() =>
				validateBatch({ ...batch(), events: [{ ...event("page_view"), payload }] }, NOW),
			).toThrow();
		}
		const payload: Record<string, unknown> = {};
		payload.self = payload;
		expect(() =>
			validateBatch({ ...batch(), events: [{ ...event("page_view"), payload }] }, NOW),
		).toThrow();
	});
	it("keeps empty payloads exact at the type boundary", () => {
		// @ts-expect-error page_view payloads cannot contain arbitrary properties
		const pagePayload: Extract<NormalizedAnalyticsEvent, { eventName: "page_view" }>["payload"] = {
			extra: true,
		};
		// @ts-expect-error experiment_exposure payloads cannot contain arbitrary properties
		const experimentPayload: Extract<
			NormalizedAnalyticsEvent,
			{ eventName: "experiment_exposure" }
		>["payload"] = { experimentId: "x" };
		expect(pagePayload).toBeDefined();
		expect(experimentPayload).toBeDefined();
	});
	it("uses locale-independent ordering for mixed-case event IDs", () => {
		const first = batch([
			{ ...event("page_view"), eventId: "Z-event", payload: {} },
			{ ...event("cta_click", { elementId: "cta" }), eventId: "a-event" },
		]);
		const reversed = [...first.events];
		// oxlint-disable-next-line unicorn(no-array-reverse), e18e(prefer-array-to-reversed) -- ES2022 runtime compatibility
		reversed.reverse();
		const second = { ...first, events: reversed };
		expect(serializeAnalyticsEventBatch(first)).toBe(serializeAnalyticsEventBatch(second));
	});
	it("detaches nested normalized payloads from caller input", () => {
		const input = batch([event("conversion", { conversionId: "lead", value: 1, currency: "USD" })]);
		const output = validateBatch(input, NOW);
		expect(output.events[0]?.payload).not.toBe(input.events[0]?.payload);
		expect(output.events[0]?.payload).toEqual(input.events[0]?.payload);
	});
	it("rejects every oversized campaign string and bounded nested input", () => {
		for (const key of ["source", "medium", "campaign", "term", "content", "clickId"])
			expect(() =>
				validateBatch(
					{ ...batch(), events: [{ ...event("page_view"), campaign: { [key]: "x".repeat(257) } }] },
					NOW,
				),
			).toThrow();
		let nested: Record<string, unknown> = {};
		for (let i = 0; i < 18; i++) nested = { next: nested };
		expect(() =>
			validateBatch({ ...batch(), events: [{ ...event("page_view"), payload: nested }] }, NOW),
		).toThrow();
	});
});
