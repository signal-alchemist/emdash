import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
	validateAnalyticsEventBatch,
	type AnalyticsEventBatch,
} from "@signal-alchemist/marketing-automation-contracts";
const DECIMAL = /^\d+$/;
const SHA256_PREFIX = /^sha256=/;
const HEX_SIGNATURE = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const RETENTION_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const cursorFor = (row: StoredBatch) =>
	`${row.receivedAt.toString().padStart(13, "0")}:${row.idempotencyKey}`;

export type StoredEvent = { eventName: string; occurredAt: number };
export type StoredBatch = {
	idempotencyKey: string;
	bodyHash: string;
	receivedAt: number;
	events: StoredEvent[];
};
export type DeletionReceipt = {
	id: string;
	deleted: number;
	at: number;
	cursor: string | null;
	policyHash: string;
};
export type CleanupClaim = {
	id: string;
	createdAt: number;
	ownerToken: string;
	leaseUntil: number;
	status: "in_progress" | "completed";
	processed: Record<string, "deleted" | "not_found">;
	cursor: string | null;
	receipt: DeletionReceipt | null;
};
export interface AnalyticsBackend {
	createIfAbsent(key: string, value: StoredBatch): Promise<"created" | "duplicate" | "conflict">;
	page(cursor: string | null, limit: number): Promise<{ rows: StoredBatch[]; next: string | null }>;
	delete(key: string): Promise<boolean>;
	claimOrResumeCleanup(
		id: string,
		now: number,
		leaseMs: number,
	): Promise<{
		state: "owner" | "in_progress" | "completed";
		ownerToken?: string;
		receipt?: DeletionReceipt;
	}>;
	deleteForCleanup(
		id: string,
		ownerToken: string,
		key: string,
	): Promise<"deleted" | "already_deleted" | "already_not_found" | "not_found">;
	finalizeCleanup(id: string, ownerToken: string, receipt: DeletionReceipt): Promise<void>;
	getCleanupClaim(id: string): Promise<CleanupClaim | null>;
}
export class MemoryAnalyticsBackend implements AnalyticsBackend {
	private readonly batches = new Map<string, StoredBatch>();
	private readonly claims = new Map<string, CleanupClaim>();
	private readonly beforeCreate?: () => Promise<void>;
	constructor(beforeCreate?: () => Promise<void>) {
		this.beforeCreate = beforeCreate;
	}
	async createIfAbsent(key: string, value: StoredBatch) {
		if (this.beforeCreate) await this.beforeCreate();
		const old = this.batches.get(key);
		if (old) return old.bodyHash === value.bodyHash ? "duplicate" : "conflict";
		this.batches.set(key, structuredClone(value));
		return "created";
	}
	async page(cursor: string | null, limit: number) {
		const rows = [...this.batches.values()].toSorted(
			(a, b) => a.receivedAt - b.receivedAt || a.idempotencyKey.localeCompare(b.idempotencyKey),
		);
		const start = cursor ? rows.findIndex((row) => cursorFor(row) > cursor) : 0;
		const page = rows.slice(Math.max(start, 0), Math.max(start, 0) + limit);
		return {
			rows: structuredClone(page),
			next: page.length && start + page.length < rows.length ? cursorFor(page.at(-1)!) : null,
		};
	}
	async delete(key: string) {
		return this.batches.delete(key);
	}
	async claimOrResumeCleanup(id: string, now: number, leaseMs: number) {
		const existing = this.claims.get(id);
		if (existing?.status === "completed")
			return { state: "completed" as const, receipt: existing.receipt! };
		if (existing && existing.leaseUntil > now) return { state: "in_progress" as const };
		const ownerToken = `${id}:${now}:${Math.random()}`;
		if (existing) {
			existing.ownerToken = ownerToken;
			existing.leaseUntil = now + leaseMs;
			return { state: "owner" as const, ownerToken };
		}
		this.claims.set(id, {
			id,
			createdAt: now,
			ownerToken,
			leaseUntil: now + leaseMs,
			status: "in_progress",
			processed: Object.create(null) as Record<string, "deleted" | "not_found">,
			cursor: null,
			receipt: null,
		});
		return { state: "owner" as const, ownerToken };
	}
	async deleteForCleanup(id: string, ownerToken: string, key: string) {
		const claim = this.claims.get(id);
		if (!claim || claim.ownerToken !== ownerToken || claim.status !== "in_progress")
			throw new Error("CLEANUP_OWNER_INVALID");
		if (Object.hasOwn(claim.processed, key))
			return claim.processed[key] === "deleted"
				? ("already_deleted" as const)
				: ("already_not_found" as const);
		const deleted = this.batches.delete(key);
		claim.processed[key] = deleted ? "deleted" : "not_found";
		return deleted ? ("deleted" as const) : ("not_found" as const);
	}
	async finalizeCleanup(id: string, ownerToken: string, receipt: DeletionReceipt) {
		const claim = this.claims.get(id);
		if (!claim || claim.ownerToken !== ownerToken) throw new Error("CLEANUP_OWNER_INVALID");
		claim.receipt = structuredClone(receipt);
		claim.status = "completed";
		claim.leaseUntil = Number.MAX_SAFE_INTEGER;
	}
	async getCleanupClaim(id: string) {
		const claim = this.claims.get(id);
		return claim ? structuredClone(claim) : null;
	}
}
export class AnalyticsStoreHandle implements AnalyticsBackend {
	constructor(
		private readonly driver: AnalyticsBackend,
		private readonly beforeCreate?: () => Promise<void>,
	) {}
	async createIfAbsent(key: string, value: StoredBatch) {
		if (this.beforeCreate) await this.beforeCreate();
		return this.driver.createIfAbsent(key, value);
	}
	page(cursor: string | null, limit: number) {
		return this.driver.page(cursor, limit);
	}
	delete(key: string) {
		return this.driver.delete(key);
	}
	claimOrResumeCleanup(id: string, now: number, leaseMs: number) {
		return this.driver.claimOrResumeCleanup(id, now, leaseMs);
	}
	deleteForCleanup(id: string, ownerToken: string, key: string) {
		return this.driver.deleteForCleanup(id, ownerToken, key);
	}
	finalizeCleanup(id: string, ownerToken: string, receipt: DeletionReceipt) {
		return this.driver.finalizeCleanup(id, ownerToken, receipt);
	}
	getCleanupClaim(id: string) {
		return this.driver.getCleanupClaim(id);
	}
}
export class AnalyticsBodyError extends Error {
	constructor(
		readonly code:
			| "BODY_TOO_LARGE"
			| "BODY_LENGTH_MISMATCH"
			| "BODY_INVALID"
			| "BODY_UTF8_INVALID"
			| "BODY_READ_FAILED",
	) {
		super(code);
		this.name = "AnalyticsBodyError";
	}
}
export async function readBoundedJson(request: Request, maxBytes = 64_000): Promise<string> {
	const length = request.headers.get("content-length");
	if (length !== null && (!DECIMAL.test(length) || Number(length) > maxBytes))
		throw new AnalyticsBodyError("BODY_TOO_LARGE");
	if (!request.body) throw new AnalyticsBodyError("BODY_INVALID");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let part: ReadableStreamReadResult<Uint8Array>;
			try {
				part = await reader.read();
			} catch {
				throw new AnalyticsBodyError("BODY_READ_FAILED");
			}
			if (part.done) break;
			total += part.value.byteLength;
			if (total > maxBytes) throw new AnalyticsBodyError("BODY_TOO_LARGE");
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	if (length !== null && Number(length) !== total)
		throw new AnalyticsBodyError("BODY_LENGTH_MISMATCH");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
		);
	} catch {
		throw new AnalyticsBodyError("BODY_UTF8_INVALID");
	}
}
export type IngestOptions = {
	secret: string;
	crypto?: { hmac(secret: string, value: string): string };
	maxBodyBytes?: number;
	now?: () => number;
	verify?: (request: Request, body: string) => Promise<boolean> | boolean;
};
export type IngestResult = {
	status: number;
	body: { accepted: boolean; code?: string; idempotencyKey?: string };
};
export class AnalyticsStorageError extends Error {
	constructor(readonly operation: "create" | "get" | "page" | "delete" | "claim" | "finalize") {
		super(`ANALYTICS_STORAGE_${operation.toUpperCase()}_FAILED`);
	}
}
const hmac = (secret: string, body: string) =>
	createHmac("sha256", secret).update(body).digest("hex");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const safeEqual = (left: string, right: string) => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};
export async function ingestAnalyticsBatch(
	request: Request,
	backend: AnalyticsBackend,
	options: IngestOptions,
): Promise<IngestResult> {
	if (request.method !== "POST")
		return { status: 405, body: { accepted: false, code: "METHOD_NOT_ALLOWED" } };
	if (
		request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
		"application/json"
	)
		return { status: 415, body: { accepted: false, code: "CONTENT_TYPE_INVALID" } };
	let body: string;
	try {
		body = await readBoundedJson(request, options.maxBodyBytes ?? 64_000);
	} catch (error) {
		const code = error instanceof AnalyticsBodyError ? error.code : "BODY_READ_FAILED";
		return { status: code === "BODY_TOO_LARGE" ? 413 : 400, body: { accepted: false, code } };
	}
	const signature = request.headers.get("x-analytics-signature")?.replace(SHA256_PREFIX, "");
	let authorized = false;
	try {
		if (options.verify) authorized = await options.verify(request, body);
		else if (options.secret.length >= 16 && signature && HEX_SIGNATURE.test(signature))
			authorized = safeEqual((options.crypto?.hmac ?? hmac)(options.secret, body), signature);
	} catch {
		authorized = false;
	}
	if (!authorized) return { status: 401, body: { accepted: false, code: "UNAUTHORIZED" } };
	if (request.headers.get("x-analytics-version") !== "1")
		return { status: 400, body: { accepted: false, code: "VERSION_UNSUPPORTED" } };
	const key = request.headers.get("x-idempotency-key");
	if (!key || !IDEMPOTENCY_KEY.test(key))
		return { status: 400, body: { accepted: false, code: "IDEMPOTENCY_KEY_INVALID" } };
	let batch: AnalyticsEventBatch;
	const now = options.now?.() ?? Date.now();
	try {
		batch = validateAnalyticsEventBatch(JSON.parse(body), { now });
	} catch {
		return { status: 400, body: { accepted: false, code: "SCHEMA_INVALID" } };
	}
	const stored: StoredBatch = {
		idempotencyKey: key,
		bodyHash: (options.crypto?.hmac ?? hmac)(options.secret, body),
		receivedAt: now,
		events: batch.events.map((event) => ({
			eventName: event.eventName,
			occurredAt: Date.parse(event.occurredAt),
		})),
	};
	let result: "created" | "duplicate" | "conflict";
	try {
		result = await backend.createIfAbsent(key, stored);
	} catch {
		return { status: 503, body: { accepted: false, code: "ANALYTICS_STORAGE_CREATE_FAILED" } };
	}
	if (result === "conflict")
		return {
			status: 409,
			body: { accepted: false, code: "IDEMPOTENCY_CONFLICT", idempotencyKey: key },
		};
	return { status: 202, body: { accepted: true, idempotencyKey: key } };
}
export type RetentionPolicy = { default?: number; [eventClass: string]: number | undefined };
const MIN_RETENTION = 86_400_000;
const MAX_RETENTION = 31_536_000_000;
export function validateRetention(policy: RetentionPolicy): RetentionPolicy {
	if (
		!policy ||
		Object.getPrototypeOf(policy) !== Object.prototype ||
		!policy.default ||
		Object.keys(policy).length === 0 ||
		Object.keys(policy).length > 32
	)
		throw new Error("RETENTION_POLICY_INVALID");
	for (const key of Object.keys(policy))
		if (key !== "default" && !RETENTION_KEY.test(key)) throw new Error("RETENTION_POLICY_INVALID");
	for (const value of Object.values(policy))
		if (
			value === undefined ||
			!Number.isSafeInteger(value) ||
			value < MIN_RETENTION ||
			value > MAX_RETENTION
		)
			throw new Error("RETENTION_POLICY_INVALID");
	return { ...policy };
}
const policyHash = (policy: RetentionPolicy) =>
	hash(JSON.stringify(Object.entries(validateRetention(policy)).toSorted()));
export async function cleanupAnalytics(
	backend: AnalyticsBackend,
	policy: RetentionPolicy,
	clock: number | { cutoffAt: number; leaseNow: number },
	limit = 100,
): Promise<DeletionReceipt> {
	const cutoffAt = typeof clock === "number" ? clock : clock.cutoffAt;
	const leaseNow = typeof clock === "number" ? clock : clock.leaseNow;
	if (
		!Number.isSafeInteger(cutoffAt) ||
		!Number.isSafeInteger(leaseNow) ||
		cutoffAt < 0 ||
		leaseNow < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 1000
	)
		throw new Error("CLEANUP_SCOPE_INVALID");
	const normalized = validateRetention(policy);
	const digest = policyHash(normalized);
	const claimId = hash(`cleanup:${cutoffAt}:${digest}:${limit}`);
	let claim: Awaited<ReturnType<AnalyticsBackend["claimOrResumeCleanup"]>>;
	try {
		claim = await backend.claimOrResumeCleanup(claimId, leaseNow, 1_000);
	} catch {
		throw new AnalyticsStorageError("claim");
	}
	if (claim.state === "completed") return claim.receipt!;
	if (claim.state === "in_progress") throw new Error("CLEANUP_IN_PROGRESS");
	const ownerToken = claim.ownerToken!;
	let cursor: string | null = null;
	let deleted = 0;
	try {
		deleted = Object.values((await backend.getCleanupClaim(claimId))?.processed ?? {}).filter(
			(outcome) => outcome === "deleted",
		).length;
	} catch {
		throw new AnalyticsStorageError("get");
	}
	for (;;) {
		let page: { rows: StoredBatch[]; next: string | null };
		try {
			page = await backend.page(cursor, limit);
		} catch {
			throw new AnalyticsStorageError("page");
		}
		for (const row of page.rows) {
			const retention = Math.max(
				...row.events.map((event) => normalized[event.eventName] ?? normalized.default!),
			);
			if (row.receivedAt <= cutoffAt - retention) {
				let outcome: Awaited<ReturnType<AnalyticsBackend["deleteForCleanup"]>>;
				try {
					outcome = await backend.deleteForCleanup(claimId, ownerToken, row.idempotencyKey);
				} catch {
					throw new AnalyticsStorageError("delete");
				}
				if (outcome === "deleted") deleted++;
			}
		}
		if (!page.next) break;
		cursor = page.next;
	}
	const receipt: DeletionReceipt = {
		id: claimId,
		deleted,
		at: cutoffAt,
		cursor,
		policyHash: digest,
	};
	try {
		await backend.finalizeCleanup(claimId, ownerToken, receipt);
	} catch {
		throw new AnalyticsStorageError("finalize");
	}
	return receipt;
}
export type Aggregate = { eventName: string; count: number; firstAt: number; lastAt: number };
export async function exportAggregates(
	backend: AnalyticsBackend,
	scope: { from: number; to: number },
	limit = 100,
): Promise<Aggregate[]> {
	if (
		!Number.isSafeInteger(scope.from) ||
		!Number.isSafeInteger(scope.to) ||
		scope.from < 0 ||
		scope.to <= scope.from ||
		scope.to - scope.from > MAX_RETENTION ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 1000
	)
		throw new Error("EXPORT_SCOPE_INVALID");
	const output = new Map<string, Aggregate>();
	let cursor: string | null = null;
	let seen = 0;
	for (;;) {
		let page: { rows: StoredBatch[]; next: string | null };
		try {
			page = await backend.page(cursor, Math.min(limit, 100));
		} catch {
			throw new AnalyticsStorageError("page");
		}
		seen += page.rows.length;
		for (const row of page.rows)
			for (const event of row.events)
				if (event.occurredAt >= scope.from && event.occurredAt < scope.to) {
					const old = output.get(event.eventName);
					if (old) {
						old.count++;
						old.firstAt = Math.min(old.firstAt, event.occurredAt);
						old.lastAt = Math.max(old.lastAt, event.occurredAt);
					} else
						output.set(event.eventName, {
							eventName: event.eventName,
							count: 1,
							firstAt: event.occurredAt,
							lastAt: event.occurredAt,
						});
				}
		if (!page.next || seen >= 10_000) break;
		cursor = page.next;
	}
	return [...output.values()].toSorted((a, b) => a.eventName.localeCompare(b.eventName));
}
