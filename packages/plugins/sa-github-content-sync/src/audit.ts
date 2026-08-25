import {
	validateContentSyncResult,
	type ContentSyncResult,
} from "@signal-alchemist/marketing-automation-contracts";

import { applySyncPlan, type ApplyContext } from "./applier.js";
import { buildSyncPlan } from "./planner.js";

export const ATTEMPT_STATES = [
	"accepted",
	"validating",
	"planned",
	"applying",
	"succeeded",
	"skipped",
	"conflict",
	"failed",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
const TERMINAL = new Set<AttemptState>(["succeeded", "skipped", "conflict", "failed"]);
const COMPLETED = new Set<AttemptState>(["succeeded", "skipped"]);
const RETRYABLE = new Set<AttemptState>(["failed"]);
const PERMANENT_CODES = new Set([
	"PLAN_INVALID",
	"APPLY_DELETE_FORBIDDEN",
	"APPLY_MAPPING_REQUIRED",
	"APPLY_MAPPING_IDENTITY",
]);
const MAX_ATTEMPTS = 512;
const MAX_WARNINGS = 128;
const MAX_TEXT = 200;
const SHA = /^[0-9a-f]{40}$/;
const ACTOR_ID = /^[1-9][0-9]{0,19}$/;
const DELIVERY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^refs\/heads\/[A-Za-z0-9._/-]{1,120}$/;
const PLAN_APPLY_ERROR = /^GITHUB_SYNC_(?:PLAN|APPLY)_[A-Z0-9_]+$/;
const ATTEMPT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const GITHUB_SYNC_PREFIX = /^GITHUB_SYNC_/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const REVISION = /^[A-Za-z0-9._:-]{1,200}$/;
const ERROR_CODE = /^(?:ATTEMPT_[A-Z0-9_]+|PLAN_[A-Z0-9_]+|APPLY_[A-Z0-9_]+)$/;
const WARNING_CODE = /^(?:content-not-found|media-[a-z-]+)$/;
const RECORD_KEYS = new Set([
	"attemptId",
	"state",
	"deliveryId",
	"repository",
	"branch",
	"commitSha",
	"actorId",
	"pullRequestNumber",
	"filesUrl",
	"planDigest",
	"contentIds",
	"mediaIds",
	"revision",
	"warnings",
	"errorCode",
	"createdAt",
	"updatedAt",
	"retryCount",
	"predecessorAttempt",
	"previous",
	"resolution",
	"reservationToken",
	"leaseExpiresAt",
	"generation",
	"history",
	"result",
]);
const activeRetries = new Map<
	string,
	Promise<{ attempt: AttemptRecord; result?: ContentSyncResult }>
>();
const MINIMUM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_WAIT_MS = 500;

export type AttemptRecord = {
	attemptId: string;
	state: AttemptState;
	deliveryId: string;
	repository: string;
	branch: string;
	commitSha: string;
	actorId: string;
	pullRequestNumber: number;
	filesUrl: string;
	planDigest?: string;
	contentIds: string[];
	mediaIds: string[];
	revision?: string;
	warnings: string[];
	errorCode?: string;
	createdAt: string;
	updatedAt: string;
	retryCount: number;
	predecessorAttempt?: string;
	previous: Array<{ path: string; contentId?: string; contentHash?: string }>;
	resolution?: {
		reviewedBy: string;
		rationale: string;
		expectedRevision: string;
		currentRevision: string;
		strategy: "reapply";
	};
	reservationToken?: string;
	leaseExpiresAt?: string;
	generation: number;
	history: Array<{ state: AttemptState; at: string }>;
	result?: ContentSyncResult;
};

type AttemptCollection = {
	get(id: string): Promise<{ id: string; data: unknown } | null>;
	create(id: string, data: unknown): Promise<boolean>;
	put(id: string, data: unknown): Promise<void>;
	delete(id: string): Promise<boolean>;
	query(options?: {
		limit?: number;
		cursor?: string;
		orderBy?: Record<string, "asc" | "desc">;
	}): Promise<{ items: Array<{ id: string; data: unknown }>; cursor?: string; hasMore: boolean }>;
};

export type AttemptContext = ApplyContext & {
	storage: ApplyContext["storage"] & { sync_attempts: AttemptCollection };
	trustedActorId?: string;
	syncPolicy?: { repository: string; branch: string };
};

const transitions: Record<AttemptState, readonly AttemptState[]> = {
	accepted: ["validating", "failed", "skipped"],
	validating: ["planned", "failed"],
	planned: ["applying", "skipped", "conflict", "failed"],
	applying: ["succeeded", "conflict", "failed"],
	succeeded: [],
	skipped: [],
	conflict: ["validating"],
	failed: ["validating"],
};

function stableCode(error: unknown): string {
	if (error instanceof Error && PLAN_APPLY_ERROR.test(error.message))
		return error.message.replace(GITHUB_SYNC_PREFIX, "");
	if (error instanceof Error && error.name === "PluginRevisionConflictError")
		return "APPLY_REVISION_CONFLICT";
	return "ATTEMPT_FAILED";
}

function now(): string {
	return new Date().toISOString();
}

function assertLease(record: AttemptRecord, ownerToken?: string): void {
	if (
		record.reservationToken &&
		(ownerToken !== record.reservationToken ||
			(record.leaseExpiresAt !== undefined && Date.parse(record.leaseExpiresAt) <= Date.now()))
	)
		throw new Error("ATTEMPT_LEASE_FENCED");
}

async function claimTransition(
	ctx: AttemptContext,
	current: AttemptRecord,
	next: AttemptState,
	updated: AttemptRecord,
): Promise<void> {
	const id = `${current.attemptId}:step:${current.generation}:${current.history.length}`;
	const digest = JSON.stringify({
		attemptId: current.attemptId,
		generation: current.generation,
		from: current.state,
		at: current.history.length,
		next,
		patch: {
			planDigest: updated.planDigest,
			contentIds: updated.contentIds,
			mediaIds: updated.mediaIds,
			revision: updated.revision,
			warnings: updated.warnings,
			errorCode: updated.errorCode,
			resolution: updated.resolution,
			result: updated.result,
		},
	});
	try {
		const won = await ctx.storage.sync_attempts.create(id, {
			attemptId: current.attemptId,
			generation: current.generation,
			step: next,
			digest,
			at: now(),
		});
		if (!won) {
			const claim = await ctx.storage.sync_attempts.get(id);
			if (
				!claim ||
				typeof claim.data !== "object" ||
				(claim.data as { digest?: unknown }).digest !== digest
			)
				throw new Error("ATTEMPT_TRANSITION_RACE");
		}
	} catch (error) {
		if (error instanceof Error && error.message === "ATTEMPT_TRANSITION_RACE") throw error;
		throw new Error("ATTEMPT_TRANSITION_CLAIM_UNAVAILABLE", { cause: error });
	}
}
function bounded(value: string): string {
	return value.slice(0, MAX_TEXT);
}

export function readAttempt(value: unknown): AttemptRecord | null {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		return null;
	const item = value as Partial<AttemptRecord>;
	if (Object.keys(item).some((key) => !RECORD_KEYS.has(key))) return null;
	if (
		typeof item.attemptId !== "string" ||
		!ATTEMPT_ID.test(item.attemptId) ||
		!ATTEMPT_STATES.includes(item.state as AttemptState) ||
		typeof item.deliveryId !== "string" ||
		!DELIVERY_ID.test(item.deliveryId) ||
		typeof item.repository !== "string" ||
		!REPOSITORY.test(item.repository) ||
		typeof item.branch !== "string" ||
		!BRANCH.test(item.branch) ||
		typeof item.commitSha !== "string" ||
		!SHA.test(item.commitSha) ||
		typeof item.actorId !== "string" ||
		!ACTOR_ID.test(item.actorId) ||
		typeof item.pullRequestNumber !== "number" ||
		!Number.isSafeInteger(item.pullRequestNumber) ||
		item.pullRequestNumber < 1 ||
		typeof item.filesUrl !== "string" ||
		item.filesUrl.length > 300 ||
		item.filesUrl !==
			`https://api.github.com/repos/${item.repository}/pulls/${item.pullRequestNumber}/files` ||
		(item.planDigest !== undefined &&
			(typeof item.planDigest !== "string" || !PLAN_DIGEST.test(item.planDigest))) ||
		(item.revision !== undefined &&
			(typeof item.revision !== "string" || !REVISION.test(item.revision))) ||
		(item.errorCode !== undefined &&
			(typeof item.errorCode !== "string" || !ERROR_CODE.test(item.errorCode))) ||
		!Array.isArray(item.contentIds) ||
		item.contentIds.length > MAX_ATTEMPTS ||
		!item.contentIds.every((id) => typeof id === "string" && id.length <= MAX_TEXT) ||
		!Array.isArray(item.mediaIds) ||
		item.mediaIds.length > MAX_ATTEMPTS ||
		!item.mediaIds.every((id) => typeof id === "string" && id.length <= MAX_TEXT) ||
		!Array.isArray(item.warnings) ||
		item.warnings.length > MAX_WARNINGS ||
		!item.warnings.every(
			(warning) =>
				typeof warning === "string" && warning.length <= MAX_TEXT && WARNING_CODE.test(warning),
		) ||
		typeof item.createdAt !== "string" ||
		typeof item.updatedAt !== "string" ||
		Number.isNaN(Date.parse(item.createdAt)) ||
		new Date(item.createdAt).toISOString() !== item.createdAt ||
		Number.isNaN(Date.parse(item.updatedAt)) ||
		new Date(item.updatedAt).toISOString() !== item.updatedAt ||
		typeof item.retryCount !== "number" ||
		!Number.isSafeInteger(item.retryCount) ||
		item.retryCount < 0 ||
		item.retryCount > MAX_ATTEMPTS ||
		!Array.isArray(item.previous) ||
		item.previous.length > MAX_ATTEMPTS ||
		!item.previous.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				Object.getPrototypeOf(entry) === Object.prototype &&
				Object.keys(entry).every((key) => ["path", "contentId", "contentHash"].includes(key)) &&
				typeof entry.path === "string" &&
				entry.path.length <= MAX_TEXT &&
				(entry.contentId === undefined ||
					(typeof entry.contentId === "string" && entry.contentId.length <= MAX_TEXT)) &&
				(entry.contentHash === undefined ||
					(typeof entry.contentHash === "string" && entry.contentHash.length <= 64)),
		) ||
		(item.predecessorAttempt !== undefined &&
			(typeof item.predecessorAttempt !== "string" || !ATTEMPT_ID.test(item.predecessorAttempt))) ||
		(item.resolution !== undefined &&
			(!item.resolution ||
				typeof item.resolution !== "object" ||
				Object.keys(item.resolution).length !== 5 ||
				typeof item.resolution.reviewedBy !== "string" ||
				item.resolution.reviewedBy.length > MAX_TEXT ||
				typeof item.resolution.rationale !== "string" ||
				item.resolution.rationale.length > MAX_TEXT ||
				typeof item.resolution.expectedRevision !== "string" ||
				!REVISION.test(item.resolution.expectedRevision) ||
				typeof item.resolution.currentRevision !== "string" ||
				!REVISION.test(item.resolution.currentRevision) ||
				item.resolution.strategy !== "reapply")) ||
		(item.reservationToken !== undefined &&
			(typeof item.reservationToken !== "string" || item.reservationToken.length > MAX_TEXT)) ||
		(item.leaseExpiresAt !== undefined &&
			(typeof item.leaseExpiresAt !== "string" ||
				Number.isNaN(Date.parse(item.leaseExpiresAt)) ||
				new Date(item.leaseExpiresAt).toISOString() !== item.leaseExpiresAt)) ||
		typeof item.generation !== "number" ||
		!Number.isSafeInteger(item.generation) ||
		item.generation < 0 ||
		typeof item.history === "undefined" ||
		!Array.isArray(item.history) ||
		item.history.length > MAX_ATTEMPTS ||
		!item.history.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				Object.keys(entry).length === 2 &&
				ATTEMPT_STATES.includes(entry.state) &&
				typeof entry.at === "string" &&
				entry.at.length <= 40 &&
				!Number.isNaN(Date.parse(entry.at)) &&
				new Date(entry.at).toISOString() === entry.at,
		) ||
		item.history[0]?.state !== "accepted" ||
		item.history.at(-1)?.state !== item.state ||
		item.history.some((entry, index, history) => index > 0 && entry.at < history[index - 1]!.at) ||
		(item.state === "planned" && item.planDigest === undefined) ||
		(item.state === "failed" && item.errorCode === undefined) ||
		(item.state === "succeeded" && item.contentIds.length === 0 && item.mediaIds.length === 0)
	)
		return null;
	if (item.result !== undefined) {
		try {
			validateContentSyncResult(item.result);
		} catch {
			return null;
		}
	}
	return item as AttemptRecord;
}

export async function createAttempt(
	ctx: AttemptContext,
	input: {
		attemptId: string;
		deliveryId: string;
		repository: string;
		branch: string;
		commitSha: string;
		actorId: string;
		pullRequestNumber: number;
		filesUrl: string;
		previous?: AttemptRecord["previous"];
		predecessorAttempt?: string;
		retryCount?: number;
		reservationToken?: string;
		generation?: number;
	},
): Promise<AttemptRecord> {
	const existing = readAttempt((await ctx.storage.sync_attempts.get(input.attemptId))?.data);
	if (existing) {
		if (
			existing.deliveryId !== input.deliveryId ||
			existing.repository !== input.repository ||
			existing.branch !== input.branch ||
			existing.commitSha !== input.commitSha
		)
			throw new Error("ATTEMPT_IDENTITY_CONFLICT");
		return existing;
	}
	const timestamp = now();
	const record: AttemptRecord = {
		attemptId: input.attemptId,
		state: "accepted",
		deliveryId: input.deliveryId,
		repository: input.repository,
		branch: input.branch,
		commitSha: input.commitSha,
		actorId: input.actorId,
		pullRequestNumber: input.pullRequestNumber,
		filesUrl: input.filesUrl,
		contentIds: [],
		mediaIds: [],
		warnings: [],
		createdAt: timestamp,
		updatedAt: timestamp,
		retryCount: input.retryCount ?? (input.predecessorAttempt ? 1 : 0),
		predecessorAttempt: input.predecessorAttempt,
		reservationToken: input.reservationToken,
		leaseExpiresAt: input.reservationToken
			? new Date(Date.now() + 30_000).toISOString()
			: undefined,
		generation: input.generation ?? (input.predecessorAttempt ? 1 : 0),
		previous: (input.previous ?? []).slice(0, MAX_ATTEMPTS),
		history: [{ state: "accepted", at: timestamp }],
	};
	const validated = readAttempt(record);
	if (!validated) throw new Error("ATTEMPT_RECORD_INVALID");
	const won = await ctx.storage.sync_attempts.create(record.attemptId, validated);
	if (!won) {
		const winner = readAttempt((await ctx.storage.sync_attempts.get(record.attemptId))?.data);
		if (!winner) throw new Error("ATTEMPT_RESERVATION_UNAVAILABLE");
		if (winner.commitSha !== record.commitSha || winner.repository !== record.repository)
			throw new Error("ATTEMPT_IDENTITY_CONFLICT");
		return winner;
	}
	const afterPut = readAttempt((await ctx.storage.sync_attempts.get(record.attemptId))?.data);
	if (!afterPut) throw new Error("ATTEMPT_STORAGE_UNVERIFIED");
	if (afterPut.commitSha !== record.commitSha || afterPut.repository !== record.repository)
		throw new Error("ATTEMPT_IDENTITY_CONFLICT");
	return afterPut;
}

export async function transitionAttempt(
	ctx: AttemptContext,
	attemptId: string,
	next: AttemptState,
	patch: Partial<AttemptRecord> = {},
	ownerToken?: string,
): Promise<AttemptRecord> {
	const current = readAttempt((await ctx.storage.sync_attempts.get(attemptId))?.data);
	if (!current) throw new Error("ATTEMPT_NOT_FOUND");
	assertLease(current, ownerToken);
	if (!transitions[current.state].includes(next)) throw new Error("ATTEMPT_INVALID_TRANSITION");
	const immutable = [
		"attemptId",
		"deliveryId",
		"repository",
		"branch",
		"commitSha",
		"actorId",
		"pullRequestNumber",
		"filesUrl",
		"createdAt",
		"retryCount",
		"predecessorAttempt",
		"previous",
	];
	if (immutable.some((key) => Object.hasOwn(patch, key)))
		throw new Error("ATTEMPT_IDENTITY_IMMUTABLE");
	const allowed = new Set([
		"planDigest",
		"contentIds",
		"mediaIds",
		"revision",
		"warnings",
		"errorCode",
		"resolution",
		"result",
	]);
	if (Object.keys(patch).some((key) => !allowed.has(key))) throw new Error("ATTEMPT_PATCH_INVALID");
	const timestamp = now();
	const updated = readAttempt({
		...current,
		...patch,
		state: next,
		updatedAt: timestamp,
		warnings: (patch.warnings ?? current.warnings).slice(0, MAX_WARNINGS).map(bounded),
		history: [...current.history, { state: next, at: timestamp }].slice(-MAX_ATTEMPTS),
	});
	if (!updated) throw new Error("ATTEMPT_RECORD_INVALID");
	await claimTransition(ctx, current, next, updated);
	await ctx.storage.sync_attempts.put(attemptId, updated);
	return updated;
}

export async function listAttempts(
	ctx: AttemptContext,
	input: { limit?: number; cursor?: string } = {},
): Promise<{ items: AttemptRecord[]; cursor?: string; hasMore: boolean }> {
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
	const page = await ctx.storage.sync_attempts.query({
		limit,
		cursor: input.cursor,
		orderBy: { createdAt: "desc" },
	});
	const items = page.items
		.map((entry) => readAttempt(entry.data))
		.filter((entry): entry is AttemptRecord => entry !== null)
		.map(projectAttempt);
	return { items, cursor: page.cursor, hasMore: page.hasMore };
}

export async function detailAttempt(
	ctx: AttemptContext,
	attemptId: string,
): Promise<AttemptRecord> {
	const record = readAttempt((await ctx.storage.sync_attempts.get(attemptId))?.data);
	if (!record) throw new Error("ATTEMPT_NOT_FOUND");
	return projectAttempt(record);
}

function projectAttempt(record: AttemptRecord): AttemptRecord {
	return {
		...record,
		contentIds: [...record.contentIds],
		mediaIds: [...record.mediaIds],
		warnings: [...record.warnings],
		previous: record.previous.map((entry) => ({ ...entry })),
		history: record.history.map((entry) => ({ ...entry })),
	};
}

export async function retryAttemptWork(
	ctx: AttemptContext,
	input: { attemptId: string; idempotencyKey: string; resolution?: AttemptRecord["resolution"] },
): Promise<{ attempt: AttemptRecord; result?: ContentSyncResult }> {
	if (!ATTEMPT_ID.test(input.idempotencyKey)) throw new Error("ATTEMPT_IDEMPOTENCY_INVALID");
	const previous = await detailAttempt(ctx, input.attemptId);
	if (COMPLETED.has(previous.state)) throw new Error("ATTEMPT_NOT_RETRYABLE");
	if (previous.state === "failed" && previous.errorCode && PERMANENT_CODES.has(previous.errorCode))
		throw new Error("ATTEMPT_NOT_RETRYABLE");
	if (previous.state === "conflict" && !input.resolution)
		throw new Error("ATTEMPT_REVIEW_REQUIRED");
	if (
		!ctx.syncPolicy ||
		ctx.syncPolicy.repository !== previous.repository ||
		ctx.syncPolicy.branch !== previous.branch
	)
		throw new Error("ATTEMPT_POLICY_INVALID");
	if (input.resolution && input.resolution.reviewedBy !== ctx.trustedActorId)
		throw new Error("ATTEMPT_REVIEW_ACTOR_INVALID");
	if (!RETRYABLE.has(previous.state) && previous.state !== "conflict")
		throw new Error("ATTEMPT_NOT_RETRYABLE");
	let retryId = `${previous.attemptId}:${input.idempotencyKey}`;
	const existing = readAttempt((await ctx.storage.sync_attempts.get(retryId))?.data);
	if (existing && TERMINAL.has(existing.state))
		return { attempt: existing, result: existing.result };
	if (
		existing?.state === "applying" &&
		existing.leaseExpiresAt &&
		Date.parse(existing.leaseExpiresAt) <= Date.now()
	)
		throw new Error("ATTEMPT_INDETERMINATE_RECONCILIATION_REQUIRED");
	if (existing && (!existing.leaseExpiresAt || Date.parse(existing.leaseExpiresAt) > Date.now())) {
		const deadline = Date.now() + RESERVATION_WAIT_MS;
		let observed = existing;
		while (!TERMINAL.has(observed.state)) {
			if (Date.now() >= deadline) throw new Error("ATTEMPT_RESERVATION_TIMEOUT");
			await new Promise((resolve) => setTimeout(resolve, 10));
			const next = readAttempt((await ctx.storage.sync_attempts.get(retryId))?.data);
			if (!next) throw new Error("ATTEMPT_RESERVATION_UNAVAILABLE");
			observed = next;
		}
		return { attempt: observed, result: observed.result };
	}
	if (existing) retryId = `${retryId}:g${existing.generation + 1}`;
	const reservationToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
	let attempt = await createAttempt(ctx, {
		attemptId: retryId,
		deliveryId: previous.deliveryId,
		repository: previous.repository,
		branch: previous.branch,
		commitSha: previous.commitSha,
		actorId: previous.actorId,
		pullRequestNumber: previous.pullRequestNumber,
		filesUrl: previous.filesUrl,
		previous: previous.previous,
		predecessorAttempt: previous.attemptId,
		retryCount: previous.retryCount + 1,
		reservationToken,
		generation: existing ? existing.generation + 1 : previous.generation + 1,
	});
	if (attempt.reservationToken !== reservationToken) {
		const deadline = Date.now() + RESERVATION_WAIT_MS;
		let winner = attempt;
		while (
			winner.state === "accepted" ||
			winner.state === "validating" ||
			winner.state === "planned" ||
			winner.state === "applying"
		) {
			if (Date.now() >= deadline) throw new Error("ATTEMPT_RESERVATION_TIMEOUT");
			await new Promise((resolve) => setTimeout(resolve, 10));
			const observed = readAttempt((await ctx.storage.sync_attempts.get(retryId))?.data);
			if (!observed) throw new Error("ATTEMPT_RESERVATION_UNAVAILABLE");
			winner = observed;
		}
		return { attempt: winner, result: winner.result };
	}
	if (attempt.retryCount !== previous.retryCount + 1)
		throw new Error("ATTEMPT_RETRY_CHAIN_INVALID");
	try {
		attempt = await transitionAttempt(ctx, retryId, "validating", {}, reservationToken);
		assertLease(attempt, reservationToken);
		if (!ctx.http) throw new Error("ATTEMPT_HTTP_REQUIRED");
		const plan = await buildSyncPlan(
			{
				deliveryId: attempt.deliveryId,
				event: "pull_request",
				repository: attempt.repository,
				branch: attempt.branch,
				commitSha: attempt.commitSha,
				actorId: attempt.actorId,
				pullRequestNumber: attempt.pullRequestNumber,
				filesUrl: attempt.filesUrl,
				previous: attempt.previous,
			},
			ctx.http.fetch.bind(ctx.http),
		);
		assertLease(
			readAttempt((await ctx.storage.sync_attempts.get(retryId))?.data) ?? attempt,
			reservationToken,
		);
		attempt = await transitionAttempt(
			ctx,
			retryId,
			"planned",
			{ planDigest: plan.planDigest },
			reservationToken,
		);
		attempt = await transitionAttempt(ctx, retryId, "applying", {}, reservationToken);
		assertLease(attempt, reservationToken);
		const applied = await applySyncPlan(plan, ctx);
		assertLease(
			readAttempt((await ctx.storage.sync_attempts.get(retryId))?.data) ?? attempt,
			reservationToken,
		);
		const next: AttemptState =
			applied.status === "succeeded"
				? "succeeded"
				: applied.status === "conflict"
					? "conflict"
					: "failed";
		attempt = await transitionAttempt(
			ctx,
			retryId,
			next,
			{
				contentIds: applied.results.flatMap((result) =>
					result.contentId ? [result.contentId] : [],
				),
				mediaIds: applied.uploadedMediaIds,
				warnings: applied.warnings,
				errorCode: next === "succeeded" ? undefined : "ATTEMPT_APPLY_FAILED",
				result: applied.results[0],
			},
			reservationToken,
		);
		return { attempt, result: attempt.result };
	} catch (error) {
		const code = stableCode(error);
		try {
			attempt = await transitionAttempt(
				ctx,
				retryId,
				code.includes("CONFLICT") ? "conflict" : "failed",
				{ errorCode: code },
				reservationToken,
			);
		} catch (transitionError) {
			if (transitionError instanceof Error && transitionError.message === "ATTEMPT_LEASE_FENCED")
				return { attempt: await detailAttempt(ctx, retryId) };
			throw transitionError;
		}
		return { attempt };
	}
}

export async function retryAttempt(
	ctx: AttemptContext,
	input: { attemptId: string; idempotencyKey: string; resolution?: AttemptRecord["resolution"] },
): Promise<{ attempt: AttemptRecord; result?: ContentSyncResult }> {
	const key = `${input.attemptId}:${input.idempotencyKey}`;
	const active = activeRetries.get(key);
	if (active) return active;
	const run = retryAttemptWork(ctx, input);
	activeRetries.set(key, run);
	try {
		return await run;
	} finally {
		if (activeRetries.get(key) === run) activeRetries.delete(key);
	}
}

export async function cleanupAttempts(
	ctx: AttemptContext,
	input: { before: string; limit?: number; minimumRetain?: number },
): Promise<number> {
	if (
		Number.isNaN(Date.parse(input.before)) ||
		new Date(input.before).toISOString() !== input.before
	)
		throw new Error("ATTEMPT_CUTOFF_INVALID");
	const cutoff = new Date(
		Math.min(Date.parse(input.before), Date.now() - MINIMUM_RETENTION_MS),
	).toISOString();
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
	const minimum = Math.max(input.minimumRetain ?? 1, 1);
	const page = await ctx.storage.sync_attempts.query({
		limit: Math.min(MAX_ATTEMPTS, limit + minimum),
		orderBy: { createdAt: "asc" },
	});
	let removed = 0;
	for (const entry of page.items.slice(0, limit)) {
		const record = readAttempt(entry.data);
		if (
			!record ||
			record.createdAt >= cutoff ||
			record.state === "applying" ||
			record.state === "validating" ||
			record.state === "planned"
		)
			continue;
		if (page.items.length - removed <= minimum) break;
		if (await ctx.storage.sync_attempts.delete(entry.id)) removed += 1;
	}
	return removed;
}
