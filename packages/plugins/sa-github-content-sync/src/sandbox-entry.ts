import type { SandboxedPlugin } from "emdash/plugin";

import { buildSyncPlan } from "./planner.js";

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
				return buildSyncPlan(routeCtx.input, ctx.http.fetch.bind(ctx.http));
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
		recent: {
			handler: async (_routeCtx, ctx) => {
				const result = await ctx.storage.sync_runs.query({
					orderBy: { createdAt: "desc" },
					limit: 20,
				});
				return { runs: result.items };
			},
		},
	},
} satisfies SandboxedPlugin;
