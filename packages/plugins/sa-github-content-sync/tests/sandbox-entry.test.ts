import { describe, expect, it } from "vitest";

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
});
