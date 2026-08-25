import {
	serializeAnalyticsEventBatch,
	validateAnalyticsEventBatch,
	type AnalyticsEventBatch,
} from "@signal-alchemist/marketing-automation-contracts";
type RouteContext<T = unknown> = {
	input: T;
	request: Request;
	requestMeta: {
		ip: string | null;
		userAgent: string | null;
		referer: string | null;
		geo: unknown;
	};
};
export class AnalyticsIngressError extends Error {
	constructor(
		public code: string,
		public status: number,
	) {
		super("Analytics request rejected");
	}
}

export const ANALYTICS_UPSTREAM = "https://analytics.signal-alchemist.example/v1/events";
export const ANALYTICS_BODY_LIMIT = 64_000;
const WINDOW_MS = 60_000;
const BODY_HMAC = /^[a-f0-9]{64}$/;

export interface DurableReservation {
	commit(): Promise<void>;
	rollback(): Promise<void>;
}
export interface DurableLimiter {
	reserve(key: string, window: number, limit: number): Promise<DurableReservation | null>;
}
export interface AnalyticsForwarder {
	forward(
		body: string,
		idempotencyKey: string,
		signal: AbortSignal,
		bodyHmac: string,
	): Promise<"accepted" | "rejected">;
}

/** A deliberately narrow transport: the collector never follows redirects or
 * reflects an upstream response/body to the caller. */
export function createAnalyticsForwarder(endpoint = ANALYTICS_UPSTREAM): AnalyticsForwarder {
	if (endpoint !== ANALYTICS_UPSTREAM || !endpoint.startsWith("https://")) {
		throw new Error("Analytics upstream must be the configured HTTPS endpoint");
	}
	return {
		async forward(body, idempotencyKey, signal, bodyHmac) {
			if (typeof bodyHmac !== "string" || !BODY_HMAC.test(bodyHmac)) {
				throw new Error("Analytics upstream body signature is invalid");
			}
			const response = await fetch(ANALYTICS_UPSTREAM, {
				method: "POST",
				redirect: "error",
				headers: {
					"content-type": "application/json",
					"x-analytics-version": "1",
					"x-idempotency-key": idempotencyKey,
					"x-analytics-signature": `sha256=${bodyHmac}`,
				},
				body,
				signal,
			});
			return response.ok ? "accepted" : "rejected";
		},
	};
}
export interface AnalyticsIngressOptions {
	limiter: DurableLimiter;
	forwarder: AnalyticsForwarder;
	secret: string;
	keyId: string;
	botDecision?: (meta: RouteContext["requestMeta"]) => "allow" | "reject";
	now?: () => number;
}

function reject(code: string, status = 400): never {
	throw new AnalyticsIngressError(code, status);
}
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	return !!origin && origin === new URL(request.url).origin;
}
async function hmac(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function ingestAnalytics(
	ctx: RouteContext,
	options: AnalyticsIngressOptions | undefined,
) {
	if (!options) reject("ANALYTICS_NOT_CONFIGURED", 503);
	if (ctx.request.method.toUpperCase() !== "POST") reject("ANALYTICS_METHOD_NOT_ALLOWED", 405);
	if (
		ctx.request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
		"application/json"
	)
		reject("ANALYTICS_CONTENT_TYPE_INVALID", 415);
	if (!sameOrigin(ctx.request)) reject("ANALYTICS_ORIGIN_INVALID", 403);
	if (!ctx.requestMeta.ip) reject("ANALYTICS_CLIENT_UNTRUSTED", 400);
	if (options.botDecision?.(ctx.requestMeta) === "reject") reject("ANALYTICS_BOT_REJECTED", 403);
	if (!options.limiter || !options.forwarder || !options.secret || !options.keyId)
		reject("ANALYTICS_NOT_CONFIGURED", 503);
	const now = options.now?.() ?? Date.now();
	let batch: AnalyticsEventBatch;
	try {
		batch = validateAnalyticsEventBatch(ctx.input, { now });
	} catch {
		reject("ANALYTICS_BATCH_INVALID", 400);
	}
	const body = serializeAnalyticsEventBatch(batch, { now });
	const window = Math.floor(now / WINDOW_MS);
	// The rate key is a rotating HMAC pseudonym. Raw IP, secret, and event body
	// never leave this function and are never handed to the limiter.
	const key = await hmac(options.secret, `${options.keyId}:rate:${window}:${ctx.requestMeta.ip}`);
	let reservation: DurableReservation | null;
	try {
		reservation = await options.limiter.reserve(key, window, 60);
	} catch {
		reject("ANALYTICS_RATE_LIMIT_UNAVAILABLE", 503);
	}
	if (!reservation) reject("ANALYTICS_RATE_LIMITED", 429);
	// Idempotency is intentionally independent of IP and rate window: retries
	// from another network or after rotation still identify the same batch.
	const idempotency = await hmac(options.secret, `${options.keyId}:batch:${body}`);
	const bodySignature = await hmac(options.secret, body);
	let settled: "commit" | "rollback" | null = null;
	let rollbackFailed = false;
	const rollback = async () => {
		if (settled) return;
		settled = "rollback";
		try {
			await reservation.rollback();
		} catch {
			rollbackFailed = true;
		}
	};
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5_000);
		try {
			const result = await options.forwarder.forward(
				body,
				idempotency,
				controller.signal,
				bodySignature,
			);
			if (result !== "accepted") {
				await rollback();
				if (rollbackFailed) reject("ANALYTICS_RATE_ROLLBACK_FAILED", 503);
				reject("ANALYTICS_UPSTREAM_REJECTED", 502);
			}
		} finally {
			clearTimeout(timeout);
		}
		if (!settled) {
			try {
				await reservation.commit();
				settled = "commit";
			} catch {
				settled = null;
				await rollback();
				reject("ANALYTICS_RATE_COMMIT_FAILED", 503);
			}
		}
		return { accepted: true };
	} catch (error) {
		await rollback();
		if (rollbackFailed) reject("ANALYTICS_RATE_ROLLBACK_FAILED", 503);
		if (error instanceof AnalyticsIngressError) throw error;
		reject(
			error instanceof DOMException && error.name === "AbortError"
				? "ANALYTICS_UPSTREAM_TIMEOUT"
				: "ANALYTICS_UPSTREAM_UNAVAILABLE",
			503,
		);
	}
}
