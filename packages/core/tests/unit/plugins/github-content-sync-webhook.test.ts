import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	verifyGithubContentSyncWebhook,
	GithubContentSyncWebhookError,
	GithubContentSyncReplayGuard,
} from "../../../src/plugins/github-content-sync-webhook.js";

const config = {
	webhookSecretEnv: "TEST_GITHUB_SECRET",
	repositories: ["signal-alchemist/site"],
	branches: ["refs/heads/main"],
	events: ["pull_request"],
};

function payload(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		action: "closed",
		repository: { full_name: "signal-alchemist/site" },
		pull_request: {
			merged: true,
			number: 42,
			merge_commit_sha: "a".repeat(40),
			base: { ref: "main" },
		},
		sender: { id: 7 },
		...overrides,
	});
}

function request(body: string, headers: Record<string, string> = {}) {
	const signature = createHmac("sha256", "secret").update(body).digest("hex");
	return new Request("https://site.test/_emdash/api/plugins/sa-github-content-sync/webhook", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": `sha256=${signature}`,
			"x-github-delivery": "delivery-1",
			"x-github-event": "pull_request",
			...headers,
		},
	});
}

describe("verifyGithubContentSyncWebhook", () => {
	it("converges concurrent duplicate deliveries to one dispatch", async () => {
		const guard = new GithubContentSyncReplayGuard();
		let calls = 0;
		const dispatch = async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
		};
		const results = await Promise.all([
			guard.run("same", dispatch),
			guard.run("same", dispatch),
			guard.run("same", dispatch),
		]);
		expect(results).toEqual([true, false, false]);
		expect(calls).toBe(1);
	});

	it("does not complete failed dispatches and applies replay capacity", async () => {
		const guard = new GithubContentSyncReplayGuard(1);
		let calls = 0;
		await expect(
			guard.run("retry", async () => {
				calls += 1;
				throw new Error("temporary");
			}),
		).rejects.toThrow("temporary");
		expect(
			await guard.run("retry", async () => {
				calls += 1;
			}),
		).toBe(true);
		expect(
			await guard.run("retry", async () => {
				calls += 1;
			}),
		).toBe(false);
		let release!: () => void;
		const pending = guard.run(
			"pending",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await expect(guard.run("other", async () => {})).rejects.toMatchObject({
			code: "GITHUB_SYNC_REPLAY_BUSY",
		});
		release();
		await pending;
		expect(calls).toBe(2);
	});

	it("verifies the exact raw bytes and returns bounded normalized input", async () => {
		const result = await verifyGithubContentSyncWebhook(request(payload()), config, "secret");
		expect(result).toEqual({
			deliveryId: "delivery-1",
			event: "pull_request",
			repository: "signal-alchemist/site",
			branch: "refs/heads/main",
			commitSha: "a".repeat(40),
			actorId: "7",
			pullRequestNumber: 42,
			filesUrl: "https://api.github.com/repos/signal-alchemist/site/pulls/42/files",
		});
	});

	it.each([
		["altered body", () => request(payload().replace('"merged":true', '"merged":false'))],
		["malformed signature", () => request(payload(), { "x-hub-signature-256": "sha256=bad" })],
		["unsupported algorithm", () => request(payload(), { "x-hub-signature-256": "sha1=bad" })],
		["missing signature", () => request(payload(), { "x-hub-signature-256": "" })],
	])("rejects %s before parsing", async (_name, makeRequest) => {
		await expect(
			verifyGithubContentSyncWebhook(makeRequest(), config, "secret"),
		).rejects.toBeInstanceOf(GithubContentSyncWebhookError);
	});

	it("fails closed for missing configuration, invalid JSON, oversized bodies, and policy mismatches", async () => {
		await expect(
			verifyGithubContentSyncWebhook(request(payload()), undefined, "secret"),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_NOT_CONFIGURED" });
		const invalid = request("not-json");
		const invalidSignature = createHmac("sha256", "secret").update("not-json").digest("hex");
		invalid.headers.set("x-hub-signature-256", `sha256=${invalidSignature}`);
		await expect(verifyGithubContentSyncWebhook(invalid, config, "secret")).rejects.toMatchObject({
			code: "GITHUB_SYNC_PAYLOAD_INVALID",
		});
		const huge = request("x".repeat(1_000_001));
		await expect(verifyGithubContentSyncWebhook(huge, config, "secret")).rejects.toMatchObject({
			status: 413,
		});
		await expect(
			verifyGithubContentSyncWebhook(request(payload({ action: "opened" })), config, "secret"),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_POLICY_REJECTED" });
		await expect(
			verifyGithubContentSyncWebhook(
				request(payload({ repository: { full_name: "evil/site" } })),
				config,
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_POLICY_REJECTED" });
		await expect(
			verifyGithubContentSyncWebhook(
				request(payload()),
				{ ...config, events: undefined },
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_NOT_CONFIGURED" });
	});

	it("bounds chunked bodies without a content-length header", async () => {
		let cancelled = false;
		let chunks = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks += 1;
				if (chunks > 1_000_001) controller.close();
				else controller.enqueue(new Uint8Array([120]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const oversized = new Request("https://site.test/webhook", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: stream,
			duplex: "half",
		} as RequestInit);
		await expect(verifyGithubContentSyncWebhook(oversized, config, "secret")).rejects.toMatchObject(
			{
				status: 413,
			},
		);
		expect(cancelled).toBe(true);
	});

	it("requires full configured refs, valid SHA, and bounded delivery metadata", async () => {
		await expect(
			verifyGithubContentSyncWebhook(
				request(
					payload({
						pull_request: {
							merged: true,
							number: 42,
							merge_commit_sha: "bad",
							base: { ref: "main" },
						},
					}),
				),
				config,
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_PAYLOAD_INVALID" });
		await expect(
			verifyGithubContentSyncWebhook(
				request(payload(), { "x-github-delivery": "bad value" }),
				config,
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_DELIVERY_INVALID" });
		await expect(
			verifyGithubContentSyncWebhook(
				request(payload(), { "x-github-event": "push" }),
				config,
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_EVENT_INVALID" });
	});

	it.each([
		["string", "42"],
		["fractional", 1.5],
		["zero", 0],
		["negative", -1],
		["unsafe", Number.MAX_SAFE_INTEGER + 1],
	])("rejects a %s pull request number", async (_label, number) => {
		await expect(
			verifyGithubContentSyncWebhook(
				request(
					payload({
						pull_request: {
							merged: true,
							number,
							merge_commit_sha: "a".repeat(40),
							base: { ref: "main" },
						},
					}),
				),
				config,
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_PAYLOAD_INVALID" });
	});

	it("accepts the maximum positive safe pull request number", async () => {
		const result = await verifyGithubContentSyncWebhook(
			request(
				payload({
					pull_request: {
						merged: true,
						number: Number.MAX_SAFE_INTEGER,
						merge_commit_sha: "a".repeat(40),
						base: { ref: "main" },
					},
				}),
			),
			config,
			"secret",
		);
		expect(result.pullRequestNumber).toBe(Number.MAX_SAFE_INTEGER);
		expect(result.filesUrl).toBe(
			`https://api.github.com/repos/signal-alchemist/site/pulls/${Number.MAX_SAFE_INTEGER}/files`,
		);
	});

	it("does not coerce hostile object-valued identity fields", async () => {
		await expect(
			verifyGithubContentSyncWebhook(
				request(
					payload({
						pull_request: {
							merged: true,
							number: { toString: "42", valueOf: 42 },
							merge_commit_sha: "a".repeat(40),
							base: { ref: "main" },
						},
						sender: { id: { toString: "7" } },
					}),
				),
				config,
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_PAYLOAD_INVALID" });
	});

	it("rejects invalid policy, content type, encoding, and positive identity values", async () => {
		await expect(
			verifyGithubContentSyncWebhook(
				request(payload()),
				{
					...config,
					repositories: ["signal-alchemist/site/extra"],
				},
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_NOT_CONFIGURED" });
		await expect(
			verifyGithubContentSyncWebhook(
				request(payload()),
				{
					...config,
					branches: ["main"],
				},
				"secret",
			),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_NOT_CONFIGURED" });
		for (const branch of ["refs/heads/.", "refs/heads/main//release", "refs/heads/main/.."])
			await expect(
				verifyGithubContentSyncWebhook(
					request(payload()),
					{
						...config,
						branches: [branch],
					},
					"secret",
				),
			).rejects.toMatchObject({ code: "GITHUB_SYNC_NOT_CONFIGURED" });
		const wrongType = request(payload(), { "content-type": "text/plain" });
		await expect(verifyGithubContentSyncWebhook(wrongType, config, "secret")).rejects.toMatchObject(
			{ code: "GITHUB_SYNC_BODY_INVALID" },
		);
		await expect(
			verifyGithubContentSyncWebhook(request(payload({ sender: { id: 0 } })), config, "secret"),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_PAYLOAD_INVALID" });
		const bytes = new Uint8Array([0xff]);
		const signature = createHmac("sha256", "secret").update(bytes).digest("hex");
		const invalidUtf8 = new Request("https://site.test/webhook", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": `sha256=${signature}`,
				"x-github-delivery": "delivery-1",
				"x-github-event": "pull_request",
			},
			body: bytes,
		});
		await expect(
			verifyGithubContentSyncWebhook(invalidUtf8, config, "secret"),
		).rejects.toMatchObject({ code: "GITHUB_SYNC_PAYLOAD_INVALID" });
	});
});
