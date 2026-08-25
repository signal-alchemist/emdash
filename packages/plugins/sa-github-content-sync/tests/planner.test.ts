import { describe, expect, it } from "vitest";

import { buildSyncPlan } from "../src/planner.js";

const repository = "signal-alchemist/site";
const commitSha = "a".repeat(40);
const contentSha = "b".repeat(40);
const mediaSha = "c".repeat(40);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const content =
	"---\ncontentId: content-launch\nlocale: en\ntype: post\ncanonicalRoute: /posts/launch/\ntitle: Launch\nslug: launch\npublishState: published\nupdatedAt: 2026-08-25T00:00:00.000Z\n---\n![hero](assets/hero.png)\n";

function contractInput(previous: unknown[] = []) {
	return {
		deliveryId: "delivery-1",
		event: "pull_request",
		repository,
		branch: "refs/heads/main",
		commitSha,
		actorId: "7",
		pullRequestNumber: 42,
		filesUrl: "https://api.github.com/repos/signal-alchemist/site/pulls/42/files",
		previous,
	};
}

function identityPayload(
	entries = [
		{
			contentId: "content-launch",
			locale: "en",
			source: { repository, branch: "refs/heads/main", path: "content/post.md", commitSha },
			kind: "post",
			revision: 1,
			canonicalRoute: "/posts/launch/",
		},
	],
	documents = [
		{
			source: { path: "content/post.md" },
			locale: "en",
			kind: "post",
			contentId: "content-launch",
			canonical: "/posts/launch/",
		},
	],
) {
	return { identityManifest: { schemaVersion: 1, siteId: "site-001", entries }, documents };
}

function response(body: string | object, init: ResponseInit = {}) {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function fetcherFor(
	files: Record<string, string | Uint8Array>,
	manifests: { identity?: unknown; media?: unknown } = {},
) {
	return async (url: string) => {
		if (url.includes("/git/trees/"))
			return response({
				tree: [
					{ path: "content/post.md", type: "blob", sha: contentSha },
					{ path: "assets/hero.png", type: "blob", sha: mediaSha },
					{ path: "content-manifest.json", type: "blob", sha: "d".repeat(40) },
					{ path: "media-manifest.json", type: "blob", sha: "e".repeat(40) },
				],
			});
		const path = url.split(`${commitSha}/`)[1];
		if (path === "content-manifest.json")
			return new Response(
				JSON.stringify(
					manifests.identity ?? {
						identityManifest: {
							schemaVersion: 1,
							siteId: "site-001",
							entries: [
								{
									contentId: "content-launch",
									locale: "en",
									source: {
										repository,
										branch: "refs/heads/main",
										path: "content/post.md",
										commitSha,
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
					},
				),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		if (path === "media-manifest.json")
			return new Response(
				JSON.stringify(
					manifests.media ?? {
						schemaVersion: 1,
						media: [
							{
								sourcePath: "assets/hero.png",
								sha256: "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
								mimeType: "image/png",
								bytes: 8,
								width: 1,
								height: 1,
								alt: "Hero",
							},
						],
					},
				),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		return new Response(files[path!] ?? "", {
			status: 200,
			headers: { "content-type": path?.startsWith("assets/") ? "image/png" : "text/plain" },
		});
	};
}

describe("buildSyncPlan", () => {
	it("fetches only the verified merge SHA and returns a byte-stable read-only plan", async () => {
		const calls: string[] = [];
		const fetcher = async (url: string, init?: RequestInit) => {
			calls.push(url);
			return fetcherFor({
				"content/post.md": content,
				"assets/hero.png": png,
			})(url, init);
		};
		const input = contractInput();
		const first = await buildSyncPlan(input, fetcher);
		const second = await buildSyncPlan(input, fetcher);
		expect(first).toEqual(second);
		expect(first.version).toBe(1);
		expect(first.commands[0]).toMatchObject({
			version: 1,
			operation: "upsert",
			contentId: "content-launch",
			source: { deliveryId: "delivery-1" },
			fields: {
				title: "Launch",
				body: "![hero](assets/hero.png)\n",
				locale: "en",
				canonicalRoute: "/posts/launch/",
				updatedAt: "2026-08-25T00:00:00.000Z",
			},
		});
		expect(JSON.parse(first.contentCatalog)).toMatchObject({
			schemaVersion: 1,
			siteId: "site-001",
		});
		expect(JSON.parse(first.mediaManifest)).toMatchObject({
			schemaVersion: 1,
			media: [{ mimeType: "image/png", width: 1, height: 1, alt: "Hero" }],
		});
		expect(first.planDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(first.totalFetchedBytes).toBeGreaterThan(0);
		expect(new TextEncoder().encode(first.contentCatalog).byteLength).toBeGreaterThan(0);
		expect(first.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "upsert-content",
					path: "content/post.md",
					slug: "launch",
				}),
				expect.objectContaining({ kind: "upsert-media", path: "assets/hero.png" }),
			]),
		);
		expect(calls.every((url) => url.includes(commitSha))).toBe(true);
	});

	it("quarantines removals and content renames without mutating storage", async () => {
		const plan = await buildSyncPlan(
			contractInput([
				{
					path: "content/old.md",
					contentHash: "66a768e8d3ccf34261c19bc01bc6a8a154854227c6fc0bf2ca5457140cf530a2",
					contentId: "content-launch",
				},
				{ path: "assets/old.png", contentHash: "e".repeat(64) },
			]),
			fetcherFor({
				"content/post.md": content,
				"assets/hero.png": png,
			}),
		);
		expect(plan.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "rename-quarantine",
					previousPath: "content/old.md",
					currentPath: "content/post.md",
				}),
				expect.objectContaining({ kind: "removal-quarantine", path: "assets/old.png" }),
			]),
		);
	});

	it("fails closed for invalid refs, malformed trees, redirects, and oversized responses", async () => {
		for (const branch of [
			"main",
			"refs/heads/main/",
			"refs/heads/main//release",
			"refs/heads/main@{1}",
			"refs/heads/main.lock",
		]) {
			await expect(buildSyncPlan({ ...contractInput(), branch }, fetcherFor({}))).rejects.toThrow(
				"GITHUB_SYNC_PLAN_INVALID",
			);
		}
		const badTree = async () =>
			response({ tree: [{ path: "../secret", type: "blob", sha: contentSha }] });
		await expect(buildSyncPlan(contractInput(), badTree)).rejects.toThrow(
			"GITHUB_SYNC_PLAN_INVALID",
		);
		const redirected = async () =>
			new Response("", { status: 302, headers: { location: "https://evil.test" } });
		await expect(buildSyncPlan(contractInput(), redirected)).rejects.toThrow(
			"GITHUB_SYNC_FETCH_FAILED",
		);
	});

	it("replays the same verified input byte-for-byte", async () => {
		const input = contractInput();
		const first = await buildSyncPlan(
			input,
			fetcherFor({ "content/post.md": content, "assets/hero.png": png }),
		);
		const replay = await buildSyncPlan(
			input,
			fetcherFor({ "assets/hero.png": png, "content/post.md": content }),
		);
		expect(replay).toEqual(first);
	});

	it("emits an explicit unpublish command for unpublished frontmatter", async () => {
		const unpublished = content.replace("publishState: published", "publishState: unpublished");
		const plan = await buildSyncPlan(
			contractInput(),
			fetcherFor({ "content/post.md": unpublished, "assets/hero.png": png }),
		);
		expect(plan.commands[0]).toMatchObject({ operation: "unpublish", publishState: "unpublished" });
	});

	it("preserves strict scheduled metadata from frontmatter", async () => {
		const scheduled = content.replace(
			"publishState: published",
			"publishState: scheduled\nscheduledFor: 2026-09-01T00:00:00.000Z",
		);
		const plan = await buildSyncPlan(
			contractInput(),
			fetcherFor({ "content/post.md": scheduled, "assets/hero.png": png }),
		);
		expect(plan.commands[0]).toMatchObject({
			publishState: "scheduled",
			scheduledFor: "2026-09-01T00:00:00.000Z",
		});
	});

	it("rejects caller-supplied manifest substitution and excess ingress keys", async () => {
		const forged = { ...contractInput(), identityManifest: identityPayload().identityManifest };
		await expect(
			buildSyncPlan(forged, fetcherFor({ "content/post.md": content, "assets/hero.png": png })),
		).rejects.toThrow("input.keys");
		await expect(
			buildSyncPlan(
				{ ...contractInput(), secret: "not-accepted" },
				fetcherFor({ "content/post.md": content, "assets/hero.png": png }),
			),
		).rejects.toThrow("input.keys");
	});

	it("rejects source coordinate drift, malformed envelopes, and invalid blob headers", async () => {
		const drift = identityPayload();
		drift.identityManifest.entries[0]!.source.branch = "refs/heads/other";
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor({ "content/post.md": content, "assets/hero.png": png }, { identity: drift }),
			),
		).rejects.toThrow("identity_source_mismatch");
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor({ "content/post.md": content, "assets/hero.png": png }, { media: {} }),
			),
		).rejects.toThrow("media_manifest_invalid");
		const evilUrl = async () => {
			const evilResponse = new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
			Object.defineProperty(evilResponse, "url", { value: "https://evil.test/tree" });
			return evilResponse;
		};
		await expect(buildSyncPlan(contractInput(), evilUrl)).rejects.toThrow(
			"GITHUB_SYNC_FETCH_FAILED",
		);
		const wrongType = async () =>
			new Response("{}", { status: 200, headers: { "content-type": "text/html" } });
		await expect(buildSyncPlan(contractInput(), wrongType)).rejects.toThrow(
			"GITHUB_SYNC_CONTENT_TYPE_INVALID",
		);
	});

	it("rejects invalid frontmatter and body/catalog identity mismatch", async () => {
		const invalid =
			"---\nlocale: en\ntype: post\ncanonicalRoute: /posts/launch/\ntitle: Launch\nslug: launch\n---\n";
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor({ "content/post.md": invalid, "assets/hero.png": png }),
			),
		).rejects.toThrow("GITHUB_SYNC_PLAN_INVALID:frontmatter.invalid");
		const mismatch = {
			...identityPayload(undefined, [
				{
					source: { path: "content/post.md" },
					locale: "en",
					kind: "post",
					contentId: "content-other",
					canonical: "/posts/launch/",
				},
			]),
		};
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor({ "content/post.md": content, "assets/hero.png": png }, { identity: mismatch }),
			),
		).rejects.toThrow("GITHUB_SYNC_PLAN_INVALID:entries[0].content_id_mismatch");
	});

	it("rejects duplicate identity and route manifests", async () => {
		const duplicate = identityPayload();
		duplicate.identityManifest.entries.push({ ...duplicate.identityManifest.entries[0]! });
		duplicate.documents.push({ ...duplicate.documents[0]! });
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor({ "content/post.md": content, "assets/hero.png": png }, { identity: duplicate }),
			),
		).rejects.toThrow("GITHUB_SYNC_PLAN_INVALID");
	});

	it("rejects SHA mismatch, missing or invalid alt, and dangling media", async () => {
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor(
					{ "content/post.md": content, "assets/hero.png": png },
					{
						media: {
							schemaVersion: 1,
							media: [
								{
									sourcePath: "assets/hero.png",
									sha256: "e".repeat(64),
									mimeType: "image/png",
									bytes: 8,
									width: 1,
									height: 1,
									alt: "Hero",
								},
							],
						},
					},
				),
			),
		).rejects.toThrow("media.sha256_mismatch");
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor(
					{ "content/post.md": content, "assets/hero.png": png },
					{
						media: {
							schemaVersion: 1,
							media: [
								{
									sourcePath: "assets/hero.png",
									sha256: "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
									mimeType: "image/png",
									bytes: 8,
									width: 1,
									height: 1,
									alt: "",
								},
							],
						},
					},
				),
			),
		).rejects.toThrow("media.alt_invalid");
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor(
					{ "content/post.md": content, "assets/hero.png": png },
					{
						media: {
							schemaVersion: 1,
							media: [
								{
									sourcePath: "assets/missing.png",
									sha256: "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
									mimeType: "image/png",
									bytes: 8,
									width: 1,
									height: 1,
									alt: "Hero",
								},
							],
						},
					},
				),
			),
		).rejects.toThrow("media.manifest_extra_tree");
	});

	it("rejects unsafe links, paths, unsupported files, and missing blobs", async () => {
		const safeExternal = content.replace(
			"![hero](assets/hero.png)",
			"[docs](https://example.com/docs)",
		);
		const safePlan = await buildSyncPlan(
			contractInput(),
			fetcherFor({ "content/post.md": safeExternal, "assets/hero.png": png }),
		);
		expect(safePlan).toMatchObject({ version: 1 });
		expect(safePlan.planDigest).not.toBe(
			(
				await buildSyncPlan(
					contractInput(),
					fetcherFor({ "content/post.md": content, "assets/hero.png": png }),
				)
			).planDigest,
		);
		const unsafe = content.replace("![hero](assets/hero.png)", "[evil](../secret)");
		await expect(
			buildSyncPlan(
				contractInput(),
				fetcherFor({ "content/post.md": unsafe, "assets/hero.png": png }),
			),
		).rejects.toThrow("content.unsafe_link");
		const unsafeTree = async () =>
			response({ tree: [{ path: "content/../secret.md", type: "blob", sha: contentSha }] });
		await expect(buildSyncPlan(contractInput(), unsafeTree)).rejects.toThrow(
			"GITHUB_SYNC_PLAN_INVALID",
		);
		const unsupported = async () =>
			response({ tree: [{ path: "content/post.txt", type: "blob", sha: contentSha }] });
		await expect(buildSyncPlan(contractInput(), unsupported)).rejects.toThrow("unsupported-file");
	});

	it("rejects HTTP failures, rate limits, redirects, and response byte/count limits", async () => {
		for (const status of [400, 404, 429, 500]) {
			const failed = async () => new Response("", { status });
			await expect(buildSyncPlan(contractInput(), failed)).rejects.toThrow(
				"GITHUB_SYNC_FETCH_FAILED",
			);
		}
		const tooLarge = async () =>
			new Response("{}", { status: 200, headers: { "content-length": "999999999" } });
		await expect(buildSyncPlan(contractInput(), tooLarge)).rejects.toThrow(
			"GITHUB_SYNC_RESPONSE_TOO_LARGE",
		);
		const tooMany = async () =>
			response({
				tree: Array.from({ length: 513 }, (_, index) => ({
					path: `content/${index}.txt`,
					type: "blob",
					sha: contentSha,
				})),
			});
		await expect(buildSyncPlan(contractInput(), tooMany)).rejects.toThrow("file-count");
	});
});
