import { describe, expect, it, vi } from "vitest";

import plugin, { readVerifiedWebhook } from "../src/sandbox-entry.js";
import { createAttempt, transitionAttempt } from "../src/audit.js";

const valid = {
	deliveryId: "delivery-1",
	event: "pull_request",
	repository: "signal-alchemist/site",
	branch: "refs/heads/main",
	commitSha: "a".repeat(40),
	actorId: "7",
	pullRequestNumber: 42,
	filesUrl: "https://api.github.com/repos/signal-alchemist/site/pulls/42/files",
};

describe("readVerifiedWebhook", () => {
	it("accepts only the bounded normalized contract", () => {
		expect(readVerifiedWebhook(valid)).toEqual(valid);
	});

	it.each([
		["an excess property", { ...valid, rawBody: "secret" }],
		["an uppercase SHA", { ...valid, commitSha: "A".repeat(40) }],
		["a derived URL mismatch", { ...valid, filesUrl: "https://example.test/files" }],
		["an invalid branch", { ...valid, branch: "main" }],
	])("rejects %s", (_name, input) => {
		expect(() => readVerifiedWebhook(input)).toThrow("GITHUB_SYNC_PAYLOAD_INVALID");
	});

	it("rejects non-plain objects", () => {
		const custom = Object.assign(Object.create({ inherited: true }), valid);
		expect(() => readVerifiedWebhook(custom)).toThrow("GITHUB_SYNC_PAYLOAD_INVALID");
		const input = Object.create(null) as Record<string, unknown>;
		Object.assign(input, valid);
		input.extra = undefined;
		expect(() => readVerifiedWebhook(input)).toThrow("GITHUB_SYNC_PAYLOAD_INVALID");
	});

	it("stores only the normalized fields under a deterministic run ID and skips exact replays", async () => {
		const records = new Map<string, Record<string, unknown>>();
		const attempts = new Map<string, unknown>();
		const storage = {
			sync_runs: {
				query: async () => ({ items: records.size ? [...records.values()] : [] }),
				put: async (id: string, value: Record<string, unknown>) => {
					records.set(id, value);
				},
			},
			sync_attempts: {
				get: async (id: string) => (attempts.has(id) ? { id, data: attempts.get(id) } : null),
				create: async (id: string, data: unknown) => {
					if (attempts.has(id)) return false;
					attempts.set(id, data);
					return true;
				},
				put: async (id: string, data: unknown) => {
					attempts.set(id, data);
				},
				delete: async () => true,
				query: async () => ({ items: [], hasMore: false }),
			},
		};
		const handler = plugin.routes.webhook.handler;
		const first = await handler({ input: valid }, { storage } as never);
		const second = await handler({ input: valid }, { storage } as never);
		expect(first).toMatchObject({ accepted: true, runId: "delivery-1:" + "a".repeat(40) });
		expect(second).toMatchObject({ accepted: false, reason: "duplicate-delivery" });
		expect([...records.keys()]).toEqual(["delivery-1:" + "a".repeat(40)]);
		expect(records.get("delivery-1:" + "a".repeat(40))).toEqual(
			expect.objectContaining({
				deliveryId: "delivery-1",
				repository: "signal-alchemist/site",
				branch: "refs/heads/main",
				commitSha: "a".repeat(40),
				operation: "upsert",
				status: "accepted",
			}),
		);
		expect(records.get("delivery-1:" + "a".repeat(40))).not.toHaveProperty("rawBody");
		expect(records.get("delivery-1:" + "a".repeat(40))).not.toHaveProperty("signature");
		expect(records.get("delivery-1:" + "a".repeat(40))).not.toHaveProperty("secret");
	});

	it("plan route reads HTTP only and never requests content, media, or storage access", async () => {
		const fetch = async () => new Response("", { status: 400 });
		const forbidden = new Proxy(
			{},
			{
				get: () => {
					throw new Error("forbidden capability accessed");
				},
			},
		);
		const handler = plugin.routes.plan.handler;
		await expect(
			handler({ input: {} }, {
				http: { fetch },
				content: forbidden,
				media: forbidden,
				storage: forbidden,
			} as never),
		).rejects.toThrow("GITHUB_SYNC_PAYLOAD_INVALID");
	});

	it("plans from a valid normalized #7 ingress record", async () => {
		const sha = "a".repeat(40);
		const body =
			"---\ncontentId: content-launch\nlocale: en\ntype: post\ncanonicalRoute: /posts/launch/\ntitle: Launch\nslug: launch\npublishState: published\nupdatedAt: 2026-08-25T00:00:00.000Z\n---\n";
		const fetch = vi.fn(async (url: string) => {
			if (url.includes("/git/trees/"))
				return new Response(
					JSON.stringify({
						tree: [
							{ path: "content/post.md", type: "blob", sha: "b".repeat(40) },
							{ path: "content-manifest.json", type: "blob", sha: "c".repeat(40) },
							{ path: "media-manifest.json", type: "blob", sha: "d".repeat(40) },
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			if (url.endsWith("/content-manifest.json"))
				return new Response(
					JSON.stringify({
						identityManifest: {
							schemaVersion: 1,
							siteId: "site-001",
							entries: [
								{
									contentId: "content-launch",
									locale: "en",
									source: {
										repository: "signal-alchemist/site",
										branch: "refs/heads/main",
										path: "content/post.md",
										commitSha: sha,
									},
									kind: "post",
									revision: 1,
									canonicalRoute: "/posts/launch/",
								},
							],
						},
						documents: [
							{
								source: { path: "content/post.md" },
								locale: "en",
								kind: "post",
								contentId: "content-launch",
								canonical: "/posts/launch/",
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			if (url.endsWith("/media-manifest.json"))
				return new Response(JSON.stringify({ schemaVersion: 1, media: [] }), {
					headers: { "content-type": "application/json" },
				});
			return new Response(body, { headers: { "content-type": "text/plain" } });
		});
		const ingress = {
			deliveryId: "delivery-1",
			event: "pull_request",
			repository: "signal-alchemist/site",
			branch: "refs/heads/main",
			commitSha: sha,
			actorId: "7",
			pullRequestNumber: 42,
			filesUrl: "https://api.github.com/repos/signal-alchemist/site/pulls/42/files",
		};
		const forbidden = new Proxy(
			{},
			{
				get: () => {
					throw new Error("forbidden capability accessed");
				},
			},
		);
		const attempts = new Map<string, unknown>();
		const result = await plugin.routes.plan.handler({ input: ingress }, {
			http: { fetch },
			content: forbidden,
			media: forbidden,
			storage: {
				sync_attempts: {
					get: async (id: string) => (attempts.has(id) ? { id, data: attempts.get(id) } : null),
					create: async (id: string, data: unknown) => {
						if (attempts.has(id)) return false;
						attempts.set(id, data);
						return true;
					},
					put: async (id: string, data: unknown) => {
						attempts.set(id, data);
					},
					delete: async () => true,
					query: async () => ({ items: [], hasMore: false }),
				},
			},
		} as never);
		expect(result).toMatchObject({ version: 1, trace: ingress });
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it("keeps audit reads and retries private and permission-gated", () => {
		expect(plugin.routes.attempts).toMatchObject({ public: false, permission: "plugins:manage" });
		expect(plugin.routes.attempt).toMatchObject({ public: false, permission: "plugins:manage" });
		expect(plugin.routes.retry).toMatchObject({ public: false, permission: "plugins:manage" });
	});
});

describe("attempt route input and policy boundaries", () => {
	it.each([
		["array", []],
		[
			"custom prototype",
			Object.create({ injected: true }, { limit: { value: 1, enumerable: true } }),
		],
		["extra key", { limit: 1, extra: true }],
		["symbol key", { limit: 1, [Symbol("extra")]: true }],
	])("rejects %s list input", async (_name, input) => {
		await expect(
			plugin.routes.attempts.handler({ input }, { storage: { sync_attempts: {} } } as never),
		).rejects.toThrow("ATTEMPT_INPUT_INVALID");
	});

	it("fails closed before any work when trusted policy is missing or malformed", async () => {
		const handler = plugin.routes.retry.handler;
		const baseCtx = {
			storage: { sync_attempts: {} },
			kv: { get: vi.fn(async () => null) },
		};
		await expect(
			handler(
				{ input: { attemptId: "a", idempotencyKey: "b" }, user: { id: "7" } },
				baseCtx as never,
			),
		).rejects.toThrow("ATTEMPT_POLICY_INVALID");
		baseCtx.kv.get = vi.fn(async () => ({ repository: "evil", branch: "main", extra: true }));
		await expect(
			handler(
				{ input: { attemptId: "a", idempotencyKey: "b" }, user: { id: "7" } },
				baseCtx as never,
			),
		).rejects.toThrow("ATTEMPT_POLICY_INVALID");
		baseCtx.kv.get = vi.fn(async () => ({
			repository: "signal-alchemist/site",
			branch: "refs/heads/main",
		}));
		await expect(
			handler(
				{ input: { attemptId: "a", idempotencyKey: "b", extra: true }, user: { id: "7" } },
				baseCtx as never,
			),
		).rejects.toThrow("ATTEMPT_INPUT_INVALID");
	});

	it("rejects repository and branch policy mismatches before fetch or writes", async () => {
		const attempts = new Map<string, unknown>();
		const fetch = vi.fn();
		const writes = vi.fn();
		const storage = {
			sync_attempts: {
				get: async (id: string) => (attempts.has(id) ? { id, data: attempts.get(id) } : null),
				create: async (id: string, data: unknown) => {
					if (attempts.has(id)) return false;
					attempts.set(id, data);
					return true;
				},
				put: writes,
				delete: async () => true,
				query: async () => ({ items: [], hasMore: false }),
			},
		};
		const seeded = await createAttempt({ storage } as never, { ...valid, attemptId: "attempt-1" });
		await transitionAttempt({ storage } as never, seeded.attemptId, "failed", {
			errorCode: "ATTEMPT_FAILED",
		});
		writes.mockClear();
		const baseCtx = { storage, http: { fetch }, kv: { get: vi.fn() } };
		for (const policy of [
			{ repository: "other/site", branch: valid.branch },
			{ repository: valid.repository, branch: "refs/heads/release" },
		]) {
			baseCtx.kv.get.mockResolvedValue(policy);
			await expect(
				plugin.routes.retry.handler(
					{ input: { attemptId: seeded.attemptId, idempotencyKey: "retry" }, user: { id: "7" } },
					baseCtx as never,
				),
			).rejects.toThrow("ATTEMPT_POLICY_INVALID");
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(writes).not.toHaveBeenCalled();
	});

	it("runs a valid successful retry through the route with controlled fetch and apply", async () => {
		const attempts = new Map<string, unknown>();
		const runs = new Map<string, unknown>();
		const mappings = new Map<string, unknown>();
		const writes = vi.fn(async (id: string, data: unknown) => attempts.set(id, data));
		const storage = {
			sync_attempts: {
				get: async (id: string) => (attempts.has(id) ? { id, data: attempts.get(id) } : null),
				create: async (id: string, data: unknown) => {
					if (attempts.has(id)) return false;
					attempts.set(id, data);
					return true;
				},
				put: writes,
				delete: async () => true,
			query: async () => ({ items: [], hasMore: false }),
			},
			sync_runs: {
				get: async (id: string) => (runs.has(id) ? { id, data: runs.get(id) } : null),
				put: async (id: string, data: unknown) => runs.set(id, structuredClone(data)),
			},
			sync_mappings: {
				get: async (id: string) => (mappings.has(id) ? { id, data: mappings.get(id) } : null),
				put: async (id: string, data: unknown) => mappings.set(id, structuredClone(data)),
				delete: async (id: string) => mappings.delete(id),
				query: async () => ({ items: [] }),
			},
		};
		const seeded = await createAttempt({ storage } as never, { ...valid, attemptId: "attempt-success" });
		await transitionAttempt({ storage } as never, seeded.attemptId, "failed", {
			errorCode: "ATTEMPT_FAILED",
		});
		const fetch = vi.fn(async (url: string) => {
			if (url.includes("/git/trees/"))
				return new Response(JSON.stringify({ tree: [
					{ path: "content/post.md", type: "blob", sha: "b".repeat(40) },
					{ path: "content-manifest.json", type: "blob", sha: "c".repeat(40) },
					{ path: "media-manifest.json", type: "blob", sha: "d".repeat(40) },
				] }), { headers: { "content-type": "application/json" } });
			if (url.endsWith("content-manifest.json"))
				return new Response(JSON.stringify({ identityManifest: { schemaVersion: 1, siteId: "site", entries: [{
					contentId: "content-launch", locale: "en", source: { repository: valid.repository, branch: valid.branch, path: "content/post.md", commitSha: valid.commitSha }, kind: "post", revision: 1, canonicalRoute: "/posts/launch/",
				}] }, documents: [{ source: { path: "content/post.md" }, locale: "en", kind: "post", contentId: "content-launch", canonical: "/posts/launch/" }] }), { headers: { "content-type": "application/json" } });
			if (url.endsWith("media-manifest.json")) return new Response(JSON.stringify({ schemaVersion: 1, media: [] }), { headers: { "content-type": "application/json" } });
			return new Response("---\ncontentId: content-launch\nlocale: en\ntype: post\ncanonicalRoute: /posts/launch/\ntitle: Launch\nslug: launch\npublishState: draft\nupdatedAt: 2026-08-25T00:00:00.000Z\n---\nLaunch", { headers: { "content-type": "text/plain" } });
		});
		const content = {
			list: async () => ({ items: [] }),
			create: vi.fn(async () => ({ id: "row-1", data: { contentId: "content-launch" }, revision: "rev-1" })),
			publish: async () => ({ id: "row-1", data: {}, revision: "rev-2" }),
			get: async () => null,
			update: async () => ({ id: "row-1", data: {}, revision: "rev-2" }),
			unpublish: async () => ({ id: "row-1", data: {}, revision: "rev-2" }),
		};
		const result = await plugin.routes.retry.handler(
			{ input: { attemptId: seeded.attemptId, idempotencyKey: "route-success" }, user: { id: "7" } },
			{ storage, http: { fetch }, content, kv: { get: vi.fn(async () => ({ repository: valid.repository, branch: valid.branch })) } } as never,
		);
		expect(result).toMatchObject({ attempt: { state: "succeeded" } });
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(content.create).toHaveBeenCalledTimes(1);
		expect(attempts.get(`${seeded.attemptId}:route-success`)).toMatchObject({
		state: "succeeded",
		result: expect.any(Object),
	});
	});

	it("rejects a mismatched resolution reviewer before doing work", async () => {
		const get = vi.fn(async () => ({ repository: valid.repository, branch: valid.branch }));
		const fetch = vi.fn();
		await expect(
			plugin.routes.retry.handler(
				{
					input: {
						attemptId: "attempt-1",
						idempotencyKey: "retry",
						resolution: {
							reviewedBy: "8",
							rationale: "review",
							expectedRevision: "rev-1",
							currentRevision: "rev-1",
							strategy: "reapply",
						},
					},
					user: { id: "7" },
				},
				{ storage: { sync_attempts: {} }, kv: { get }, http: { fetch } } as never,
			),
		).rejects.toThrow("ATTEMPT_REVIEW_ACTOR_INVALID");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects accessors, setters, null, custom, and symbol inputs without invoking getters", async () => {
		const getter = vi.fn(() => "signal-alchemist/site");
		const policy = { branch: valid.branch, repository: "signal-alchemist/site" };
		Object.defineProperty(policy, "repository", { get: getter, enumerable: true });
		const kv = { get: vi.fn(async () => policy) };
		const work = vi.fn();
		await expect(
			plugin.routes.retry.handler(
				{ input: { attemptId: "a", idempotencyKey: "b" }, user: { id: "7" } },
				{ storage: { sync_attempts: {} }, kv, http: { fetch: work } } as never,
			),
		).rejects.toThrow("ATTEMPT_POLICY_INVALID");
		await expect(
			plugin.routes.retry.handler(
				{ input: { attemptId: "a", idempotencyKey: "b", [Symbol("x")]: true }, user: { id: "7" } },
				{ storage: { sync_attempts: {} }, kv: { get: vi.fn(async () => null) }, http: { fetch: work } } as never,
			),
		).rejects.toThrow("ATTEMPT_INPUT_INVALID");
		expect(getter).not.toHaveBeenCalled();
		expect(work).not.toHaveBeenCalled();
		await expect(
			plugin.routes.retry.handler(
				{ input: null, user: { id: "7" } },
				{ storage: { sync_attempts: {} }, kv, http: { fetch: work } } as never,
			),
		).rejects.toThrow("ATTEMPT_INPUT_INVALID");
	});
});
