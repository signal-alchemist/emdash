import type { SandboxedPlugin } from "emdash/plugin";

import { applySyncPlan, type ApplyContext } from "./applier.js";
import {
	createAttempt,
	detailAttempt,
	listAttempts,
	retryAttempt,
	transitionAttempt,
	type AttemptContext,
} from "./audit.js";
import { buildSyncPlan, validateSyncPlan } from "./planner.js";
import {
	listSyncReceipts,
	readSyncReceipt,
	rollbackSyncReceipt,
	toReceiptView,
	type ReceiptCollection,
	type ReceiptContent,
} from "./receipts.js";

type StagedSync = {
	deliveryId: string;
	repository: string;
	branch: string;
	commitSha: string;
	sourcePath: string;
	operation: "upsert" | "rename" | "unpublish" | "delete";
	contentId?: string;
	expectedRevision?: string;
};

type VerifiedWebhook = {
	deliveryId: string;
	event: "pull_request";
	repository: string;
	branch: string;
	commitSha: string;
	actorId: string;
	pullRequestNumber: number;
	filesUrl: string;
};

const VERIFIED_KEYS = [
	"actorId",
	"branch",
	"commitSha",
	"deliveryId",
	"event",
	"filesUrl",
	"pullRequestNumber",
	"repository",
] as const;
const DELIVERY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^refs\/heads\/[A-Za-z0-9._/-]{1,120}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const ACTOR_ID = /^[1-9][0-9]{0,19}$/;
const POLICY_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POLICY_BRANCH = /^refs\/heads\/[A-Za-z0-9._/-]{1,120}$/;
const ATTEMPT_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function hasAttemptStorage(storage: unknown): boolean {
	try {
		return Boolean((storage as { sync_attempts?: unknown }).sync_attempts);
	} catch {
		return false;
	}
}

function requireAttemptStorage(ctx: { storage: unknown }): AttemptContext {
	if (!hasAttemptStorage(ctx.storage)) throw new Error("ATTEMPT_STORAGE_REQUIRED");
	return ctx as unknown as AttemptContext;
}

function exactObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Object.prototype
	)
		throw new Error("ATTEMPT_INPUT_INVALID");
	const value = input as Record<string, unknown>;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)))
		throw new Error("ATTEMPT_INPUT_INVALID");
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && (descriptor.get || descriptor.set)) throw new Error("ATTEMPT_INPUT_INVALID");
	}
	return value;
}

function readAttemptListInput(input: unknown): { limit?: number; cursor?: string } {
	const value = exactObject(input ?? {}, ["limit", "cursor"]);
	if (
		value.limit !== undefined &&
		(typeof value.limit !== "number" ||
			!Number.isSafeInteger(value.limit) ||
			value.limit < 1 ||
			value.limit > 100)
	)
		throw new Error("ATTEMPT_INPUT_INVALID");
	if (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 512))
		throw new Error("ATTEMPT_INPUT_INVALID");
	return value as { limit?: number; cursor?: string };
}

function readRetryInput(input: unknown): {
	attemptId: string;
	idempotencyKey: string;
	resolution?: {
		reviewedBy: string;
		rationale: string;
		expectedRevision: string;
		currentRevision: string;
		strategy: "reapply";
	};
} {
	const value = exactObject(input, ["attemptId", "idempotencyKey", "resolution"]);
	if (
		typeof value.attemptId !== "string" ||
		!ATTEMPT_ID.test(value.attemptId) ||
		typeof value.idempotencyKey !== "string" ||
		!ATTEMPT_ID.test(value.idempotencyKey)
	)
		throw new Error("ATTEMPT_INPUT_INVALID");
	if (value.resolution === undefined)
		return { attemptId: value.attemptId, idempotencyKey: value.idempotencyKey };
	const resolution = exactObject(value.resolution, [
		"reviewedBy",
		"rationale",
		"expectedRevision",
		"currentRevision",
		"strategy",
	]);
	if (
		Object.keys(resolution).length !== 5 ||
		Object.values(resolution).some(
			(item) => typeof item !== "string" || item.length === 0 || item.length > 200,
		) ||
		resolution.strategy !== "reapply"
	)
		throw new Error("ATTEMPT_INPUT_INVALID");
	return {
		attemptId: value.attemptId,
		idempotencyKey: value.idempotencyKey,
		resolution: resolution as never,
	};
}

function readStagedSync(input: unknown): StagedSync {
	if (!input || typeof input !== "object") {
		throw new Error("A synchronization command is required");
	}
	const value = input as Record<string, unknown>;
	const required = [
		"deliveryId",
		"repository",
		"branch",
		"commitSha",
		"sourcePath",
		"operation",
	] as const;
	for (const key of required) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			throw new Error(`Invalid or missing ${key}`);
		}
	}
	const operation = value.operation;
	if (
		operation !== "upsert" &&
		operation !== "rename" &&
		operation !== "unpublish" &&
		operation !== "delete"
	) {
		throw new Error("Unsupported synchronization operation");
	}
	return {
		deliveryId: value.deliveryId as string,
		repository: value.repository as string,
		branch: value.branch as string,
		commitSha: value.commitSha as string,
		sourcePath: value.sourcePath as string,
		operation,
		contentId: typeof value.contentId === "string" ? value.contentId : undefined,
		expectedRevision:
			typeof value.expectedRevision === "string" ? value.expectedRevision : undefined,
	};
}

export function readVerifiedWebhook(input: unknown): VerifiedWebhook {
	if (
		!input ||
		typeof input !== "object" ||
		(Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
	)
		throw new Error("GITHUB_SYNC_PAYLOAD_INVALID");
	const value = input as Record<string, unknown>;
	if (
		Object.keys(value).length !== VERIFIED_KEYS.length ||
		VERIFIED_KEYS.some((key) => !Object.hasOwn(value, key)) ||
		typeof value.deliveryId !== "string" ||
		!DELIVERY_ID.test(value.deliveryId) ||
		typeof value.repository !== "string" ||
		value.repository.length > 200 ||
		!REPOSITORY.test(value.repository) ||
		typeof value.branch !== "string" ||
		!BRANCH.test(value.branch) ||
		typeof value.commitSha !== "string" ||
		!COMMIT_SHA.test(value.commitSha) ||
		typeof value.actorId !== "string" ||
		!ACTOR_ID.test(value.actorId) ||
		typeof value.filesUrl !== "string" ||
		value.filesUrl !==
			`https://api.github.com/repos/${value.repository}/pulls/${value.pullRequestNumber}/files` ||
		value.event !== "pull_request" ||
		typeof value.pullRequestNumber !== "number" ||
		!Number.isSafeInteger(value.pullRequestNumber) ||
		value.pullRequestNumber < 1
	)
		throw new Error("GITHUB_SYNC_PAYLOAD_INVALID");
	return value as unknown as VerifiedWebhook;
}

export default {
	routes: {
		plan: {
			handler: async (routeCtx, ctx) => {
				if (!ctx.http) throw new Error("GitHub plan requires network:request capability");
				const input = readVerifiedWebhook(routeCtx.input);
				const attempts = requireAttemptStorage(ctx);
				const attempt = await createAttempt(attempts, {
					attemptId: `${input.deliveryId}:${input.commitSha}`,
					deliveryId: input.deliveryId,
					repository: input.repository,
					branch: input.branch,
					commitSha: input.commitSha,
					actorId: input.actorId,
					pullRequestNumber: input.pullRequestNumber,
					filesUrl: input.filesUrl,
				});
				if (attempt.state === "accepted")
					await transitionAttempt(attempts, attempt.attemptId, "validating");
				try {
					const plan = await buildSyncPlan(routeCtx.input, ctx.http.fetch.bind(ctx.http));
					const current = await detailAttempt(attempts, attempt.attemptId);
					if (current.state === "validating")
						await transitionAttempt(attempts, current.attemptId, "planned", {
							planDigest: plan.planDigest,
						});
					return plan;
				} catch (error) {
					await transitionAttempt(attempts, attempt.attemptId, "failed", {
						errorCode: "PLAN_INVALID",
					});
					throw error;
				}
			},
		},
		apply: {
			handler: async (routeCtx, ctx) => {
				const plan = await validateSyncPlan(routeCtx.input);
				const attempts = requireAttemptStorage(ctx);
				const attemptId = `${plan.trace.deliveryId}:${plan.trace.commitSha}`;
				const current = await detailAttempt(attempts, attemptId);
				if (
					current.planDigest !== plan.planDigest ||
					current.repository !== plan.repository ||
					current.commitSha !== plan.commitSha
				)
					throw new Error("ATTEMPT_PLAN_IDENTITY_CONFLICT");
				if (current.state === "planned") await transitionAttempt(attempts, attemptId, "applying");
				try {
					const applied = await applySyncPlan(plan, ctx as unknown as ApplyContext);
					if (attemptId) {
						const next =
							applied.status === "succeeded"
								? "succeeded"
								: applied.status === "conflict"
									? "conflict"
									: "failed";
						await transitionAttempt(attempts, attemptId, next, {
							contentIds: applied.results.flatMap((result) =>
								result.contentId ? [result.contentId] : [],
							),
							mediaIds: applied.uploadedMediaIds,
							warnings: applied.warnings,
							errorCode: next === "succeeded" ? undefined : "ATTEMPT_APPLY_FAILED",
							result: applied.results[0],
						});
					}
					return applied;
				} catch (error) {
					if (attemptId)
						await transitionAttempt(attempts, attemptId, "failed", {
							errorCode: "ATTEMPT_APPLY_FAILED",
						});
					throw error;
				}
			},
		},
		webhook: {
			public: true,
			handler: async (routeCtx, ctx) => {
				const webhook = readVerifiedWebhook(routeCtx.input);
				const existing = await ctx.storage.sync_runs.query({
					where: { deliveryId: webhook.deliveryId },
					limit: 1,
				});
				if (existing.items.length > 0)
					return { accepted: false, reason: "duplicate-delivery", deliveryId: webhook.deliveryId };
				const createdAt = new Date().toISOString();
				const runId = `${webhook.deliveryId}:${webhook.commitSha}`;
				const attempts = requireAttemptStorage(ctx);
				await createAttempt(attempts, {
					attemptId: runId,
					deliveryId: webhook.deliveryId,
					repository: webhook.repository,
					branch: webhook.branch,
					commitSha: webhook.commitSha,
					actorId: webhook.actorId,
					pullRequestNumber: webhook.pullRequestNumber,
					filesUrl: webhook.filesUrl,
				});
				await ctx.storage.sync_runs.put(runId, {
					...webhook,
					operation: "upsert",
					status: "accepted",
					createdAt,
				});
				return { accepted: true, runId, deliveryId: webhook.deliveryId };
			},
		},
		health: {
			handler: async () => ({
				ok: true,
				plugin: "sa-github-content-sync",
				phase: "foundation",
			}),
		},
		stage: {
			handler: async (routeCtx, ctx) => {
				const command = readStagedSync(routeCtx.input);
				const existing = await ctx.storage.sync_runs.query({
					where: { deliveryId: command.deliveryId },
					limit: 1,
				});
				if (existing.items.length > 0) {
					return { accepted: false, reason: "duplicate-delivery", deliveryId: command.deliveryId };
				}
				const createdAt = new Date().toISOString();
				const runId = `${command.deliveryId}:${command.commitSha}:${command.sourcePath}`;
				await ctx.storage.sync_runs.put(runId, { ...command, status: "accepted", createdAt });
				ctx.log.info("Synchronization command staged", {
					deliveryId: command.deliveryId,
					commitSha: command.commitSha,
					sourcePath: command.sourcePath,
					operation: command.operation,
				});
				return { accepted: true, runId, createdAt };
			},
		},
		attempts: {
			public: false,
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) =>
				listAttempts(ctx as unknown as AttemptContext, readAttemptListInput(routeCtx.input)),
		},
		attempt: {
			public: false,
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const input = exactObject(routeCtx.input, ["attemptId"]);
				if (typeof input.attemptId !== "string") throw new Error("ATTEMPT_ID_INVALID");
				return detailAttempt(ctx as unknown as AttemptContext, input.attemptId);
			},
		},
		retry: {
			public: false,
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const input = readRetryInput(routeCtx.input);
				const host = ctx as unknown as AttemptContext;
				const user = (routeCtx as unknown as { user?: { id?: unknown } }).user;
				if (typeof user?.id !== "string") throw new Error("ATTEMPT_ACTOR_REQUIRED");
				const configured = await (
					ctx as unknown as { kv?: { get(key: string): Promise<unknown> } }
				).kv?.get("settings:syncPolicy");
				if (
					!configured ||
					typeof configured !== "object" ||
					Array.isArray(configured) ||
					Object.getPrototypeOf(configured) !== Object.prototype ||
					Reflect.ownKeys(configured).some((key) => key !== "repository" && key !== "branch") ||
					Object.values(Object.getOwnPropertyDescriptors(configured)).some((descriptor) =>
						Boolean(descriptor.get || descriptor.set),
					) ||
					typeof (configured as { repository?: unknown }).repository !== "string" ||
					typeof (configured as { branch?: unknown }).branch !== "string" ||
					!POLICY_REPOSITORY.test((configured as { repository: string }).repository) ||
					!POLICY_BRANCH.test((configured as { branch: string }).branch)
				)
					throw new Error("ATTEMPT_POLICY_INVALID");
				if (input.resolution && input.resolution.reviewedBy !== user.id)
					throw new Error("ATTEMPT_REVIEW_ACTOR_INVALID");
				return retryAttempt(
					{
						...host,
						trustedActorId: user.id,
						syncPolicy: {
							repository: (configured as { repository: string }).repository,
							branch: (configured as { branch: string }).branch,
						},
					} as AttemptContext,
					input,
				);
			},
		},
		receipts: {
			public: false,
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) =>
				listSyncReceipts(
					(ctx.storage as unknown as { sync_receipts: ReceiptCollection }).sync_receipts,
					readAttemptListInput(routeCtx.input),
				),
		},
		receipt: {
			public: false,
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const input = exactObject(routeCtx.input, ["receiptId"]);
				if (typeof input.receiptId !== "string") throw new Error("GITHUB_SYNC_RECEIPT_ID");
				const receipt = await readSyncReceipt(
					(ctx.storage as unknown as { sync_receipts: ReceiptCollection }).sync_receipts,
					input.receiptId,
				);
				if (!receipt) throw new Error("GITHUB_SYNC_RECEIPT_NOT_FOUND");
				return toReceiptView(receipt);
			},
		},
		rollback: {
			public: false,
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const input = exactObject(routeCtx.input, ["receiptId", "reviewedBy", "rationale"]);
				const user = (routeCtx as unknown as { user?: { id?: unknown } }).user;
				if (typeof user?.id !== "string") throw new Error("GITHUB_SYNC_RECEIPT_ACTOR_REQUIRED");
				if (
					typeof input.receiptId !== "string" ||
					(input.reviewedBy !== undefined && typeof input.reviewedBy !== "string") ||
					typeof input.rationale !== "string"
				)
					throw new Error("GITHUB_SYNC_RECEIPT_INPUT");
				if (input.reviewedBy !== undefined && input.reviewedBy !== user.id)
					throw new Error("GITHUB_SYNC_RECEIPT_ACTOR_MISMATCH");
				const receipt = await readSyncReceipt(
					(ctx.storage as unknown as { sync_receipts: ReceiptCollection }).sync_receipts,
					input.receiptId,
				);
				if (!receipt) throw new Error("GITHUB_SYNC_RECEIPT_NOT_FOUND");
				if (!ctx.content) throw new Error("GITHUB_SYNC_RECEIPT_CONTENT_CAPABILITY");
				return toReceiptView(
					await rollbackSyncReceipt(
						(ctx.storage as unknown as { sync_receipts: ReceiptCollection }).sync_receipts,
						receipt,
						ctx.content as unknown as ReceiptContent,
						user.id,
						input.rationale,
					),
				);
			},
		},
	},
} satisfies SandboxedPlugin;
