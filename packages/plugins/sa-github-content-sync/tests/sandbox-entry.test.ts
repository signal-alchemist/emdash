import { describe, expect, it, vi } from "vitest";

import plugin, { readVerifiedWebhook } from "../src/sandbox-entry.js";

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
		const storage = {
			sync_runs: {
				query: async () => ({ items: records.size ? [...records.values()] : [] }),
				put: async (id: string, value: Record<string, unknown>) => {
					records.set(id, value);
				},
			},
		};
		const handler = plugin.routes.webhook.handler;
		const first = await handler({ input: valid }, { storage } as never);
		const second = await handler({ input: valid }, { storage } as never);
		expect(first).toMatchObject({ accepted: true, runId: "delivery-1:" + "a".repeat(40) });
		expect(second).toMatchObject({ accepted: false, reason: "duplicate-delivery" });
		expect([...records.keys()]).toEqual(["delivery-1:" + "a".repeat(40)]);
		expect(records.get("delivery-1:" + "a".repeat(40))).toEqual(expect.objectContaining({
			deliveryId: "delivery-1",
			repository: "signal-alchemist/site",
			branch: "refs/heads/main",
			commitSha: "a".repeat(40),
			operation: "upsert",
			status: "accepted",
		}));
		expect(records.get("delivery-1:" + "a".repeat(40))).not.toHaveProperty("rawBody");
		expect(records.get("delivery-1:" + "a".repeat(40))).not.toHaveProperty("signature");
		expect(records.get("delivery-1:" + "a".repeat(40))).not.toHaveProperty("secret");
	});

	it("plan route reads HTTP only and never requests content, media, or storage access", async () => {
		const fetch = async () => new Response("", { status: 400 });
		const forbidden = new Proxy({}, { get: () => { throw new Error("forbidden capability accessed"); } });
		const handler = plugin.routes.plan.handler;
		await expect(handler({ input: {} }, { http: { fetch }, content: forbidden, media: forbidden, storage: forbidden } as never))
			.rejects.toThrow("GITHUB_SYNC_PLAN_INVALID");
	});

	it("plans from a valid normalized #7 ingress record", async () => {
		const sha = "a".repeat(40);
		const body = "---\ncontentId: content-launch\nlocale: en\ntype: post\ncanonicalRoute: /posts/launch/\ntitle: Launch\nslug: launch\npublishState: published\nupdatedAt: 2026-08-25T00:00:00.000Z\n---\n";
		const fetch = vi.fn(async (url: string) => {
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [
				{ path: "content/post.md", type: "blob", sha: "b".repeat(40) },
				{ path: "content-manifest.json", type: "blob", sha: "c".repeat(40) },
				{ path: "media-manifest.json", type: "blob", sha: "d".repeat(40) },
			] }), { headers: { "content-type": "application/json" } });
			if (url.endsWith("/content-manifest.json")) return new Response(JSON.stringify({ identityManifest: { schemaVersion: 1, siteId: "site-001", entries: [{ contentId: "content-launch", locale: "en", source: { repository: "signal-alchemist/site", branch: "refs/heads/main", path: "content/post.md", commitSha: sha }, kind: "post", revision: 1, canonicalRoute: "/posts/launch/" }] }, documents: [{ source: { path: "content/post.md" }, locale: "en", kind: "post", contentId: "content-launch", canonical: "/posts/launch/" }] }), { headers: { "content-type": "application/json" } });
			if (url.endsWith("/media-manifest.json")) return new Response(JSON.stringify({ schemaVersion: 1, media: [] }), { headers: { "content-type": "application/json" } });
			return new Response(body, { headers: { "content-type": "text/plain" } });
		});
		const ingress = { deliveryId: "delivery-1", event: "pull_request", repository: "signal-alchemist/site", branch: "refs/heads/main", commitSha: sha, actorId: "7", pullRequestNumber: 42, filesUrl: "https://api.github.com/repos/signal-alchemist/site/pulls/42/files" };
		const forbidden = new Proxy({}, { get: () => { throw new Error("forbidden capability accessed"); } });
		const result = await plugin.routes.plan.handler({ input: ingress }, { http: { fetch }, content: forbidden, media: forbidden, storage: forbidden } as never);
		expect(result).toMatchObject({ version: 1, trace: ingress });
		expect(fetch).toHaveBeenCalledTimes(4);
	});
});
