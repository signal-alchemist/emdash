import { describe, expect, it, vi } from "vitest";

import { applySyncPlan } from "../src/applier.js";
import { buildSyncPlan, hexDigest, stableStringify } from "../src/planner.js";
import { prepareSyncReceipt } from "../src/receipts.js";

const sha = "a".repeat(40);
const repository = "signal-alchemist/site";
const input = {
	deliveryId: "delivery-9",
	event: "pull_request",
	repository,
	branch: "refs/heads/main",
	commitSha: sha,
	actorId: "7",
	pullRequestNumber: 9,
	filesUrl: `https://api.github.com/repos/${repository}/pulls/9/files`,
	previous: [],
};
const body =
	"---\ncontentId: content-launch\nlocale: en\ntype: post\ncanonicalRoute: /posts/launch/\ntitle: Launch\nslug: launch\npublishState: published\nupdatedAt: 2026-08-25T00:00:00.000Z\n---\nHello\n";

function planFetcher(url: string): Promise<Response> {
	if (url.includes("/git/trees/"))
		return Promise.resolve(
			new Response(
				JSON.stringify({
					tree: [
						{ path: "content/post.md", type: "blob", sha: "b".repeat(40) },
						{ path: "content-manifest.json", type: "blob", sha: "c".repeat(40) },
						{ path: "media-manifest.json", type: "blob", sha: "d".repeat(40) },
					],
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
	if (url.endsWith("/content-manifest.json"))
		return Promise.resolve(
			new Response(
				JSON.stringify({
					identityManifest: {
						schemaVersion: 1,
						siteId: "site",
						entries: [
							{
								contentId: "content-launch",
								locale: "en",
								source: {
									repository,
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
			),
		);
	if (url.endsWith("/media-manifest.json"))
		return Promise.resolve(
			new Response(JSON.stringify({ schemaVersion: 1, media: [] }), {
				headers: { "content-type": "application/json" },
			}),
		);
	return Promise.resolve(new Response(body, { headers: { "content-type": "text/plain" } }));
}

async function makePlan() {
	return buildSyncPlan(input, planFetcher);
}

async function redigest(plan: Awaited<ReturnType<typeof makePlan>>) {
	const core = {
		version: 1 as const,
		repository: plan.repository,
		commitSha: plan.commitSha,
		branch: plan.branch,
		catalog: plan.catalog,
		actions: plan.actions,
		contentCatalog: plan.contentCatalog,
		mediaManifest: plan.mediaManifest,
		commands: plan.commands,
	};
	const bytes = new TextEncoder().encode(stableStringify(core));
	plan.totalPlanBytes = bytes.byteLength;
	plan.planDigest = await hexDigest(bytes);
}

function storage() {
	const records = new Map<string, unknown>();
	const mappings = new Map<string, unknown>();
	return {
		records,
		mappings,
		sync_runs: {
			get: vi.fn(async (id: string) => (records.has(id) ? { id, data: records.get(id) } : null)),
			put: vi.fn(async (id: string, data: unknown) => {
				records.set(id, structuredClone(data));
			}),
		},
		sync_mappings: {
			get: vi.fn(async (id: string) => (mappings.has(id) ? { id, data: mappings.get(id) } : null)),
			put: vi.fn(async (id: string, data: unknown) => {
				mappings.set(id, structuredClone(data));
			}),
			delete: vi.fn(async (id: string) => mappings.delete(id)),
			query: vi.fn(async () => ({
				items: Array.from(mappings.entries(), ([id, data]) => ({ id, data })),
			})),
		},
	};
}

function receiptStorage() {
	const rows = new Map<string, unknown>();
	return {
		rows,
		get: vi.fn(async (id: string) => (rows.has(id) ? { id, data: rows.get(id) } : null)),
		create: vi.fn(async (id: string, data: unknown) => {
			if (rows.has(id)) return false;
			rows.set(id, structuredClone(data));
			return true;
		}),
		put: vi.fn(async (id: string, data: unknown) => {
			rows.set(id, structuredClone(data));
		}),
		delete: vi.fn(async (id: string) => rows.delete(id)),
		query: vi.fn(async () => ({
			items: Array.from(rows.entries(), ([id, data]) => ({ id, data })),
		})),
	};
}

describe("applySyncPlan", () => {
	it("allows exactly one durable mutator across isolated contexts without time takeover", async () => {
		const plan = await makePlan();
		const store = storage();
		const receipts = receiptStorage();
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const final = {
			id: "row-1",
			data: plan.commands[0]!.fields,
			revision: "rev-2",
			status: "published",
		};
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => final),
			create: vi.fn(async () => {
				entered();
				await gate;
				return { ...final, revision: "rev-1", status: "draft" };
			}),
			update: vi.fn(),
			publish: vi.fn(async () => final),
			unpublish: vi.fn(),
		};
		vi.resetModules();
		const left = await import("../src/applier.js");
		vi.resetModules();
		const right = await import("../src/applier.js");
		const context = { storage: { ...store, sync_receipts: receipts }, content } as never;
		const winner = left.applySyncPlan(plan, context);
		await started;
		await expect(right.applySyncPlan(plan, context)).rejects.toThrow("RECEIPT_IN_PROGRESS");
		release();
		expect((await winner).status).toBe("succeeded");
		expect(content.create).toHaveBeenCalledTimes(1);
	});

	it("rejects a conflicting prepared receipt before mutation", async () => {
		const plan = await makePlan();
		const store = storage();
		const receipts = receiptStorage();
		const prepared = await prepareSyncReceipt(plan, plan.trace.actorId);
		prepared.operations[0]!.intendedDigest = "0".repeat(64);
		await receipts.put(prepared.receiptId, prepared);
		const content = {
			list: vi.fn(),
			get: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			publish: vi.fn(),
			unpublish: vi.fn(),
		};
		await expect(
			applySyncPlan(plan, { storage: { ...store, sync_receipts: receipts }, content } as never),
		).rejects.toThrow("RECEIPT_IDENTITY");
		expect(content.create).not.toHaveBeenCalled();
	});

	it("persists a verified receipt only after canonical production read-back", async () => {
		const plan = await makePlan();
		const store = storage();
		const receipts = receiptStorage();
		let current = {
			id: "row-1",
			data: plan.commands[0]!.fields,
			revision: "rev-2",
			status: "published",
		};
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => current),
			create: vi.fn(async () => ({ ...current, revision: "rev-1", status: "draft" })),
			update: vi.fn(),
			publish: vi.fn(async () => current),
			unpublish: vi.fn(async () => {
				current = { ...current, revision: "rev-3", status: "unpublished" };
				return current;
			}),
		};
		const result = await applySyncPlan(plan, {
			storage: { ...store, sync_receipts: receipts },
			content,
		} as never);
		expect(result.status).toBe("succeeded");
		const receiptId = `${plan.trace.deliveryId}:${plan.commitSha}:${plan.planDigest}`;
		expect((receipts.rows.get(receiptId) as { state: string }).state).toBe("rollback-eligible");
	});

	it("records an explicit failure when production content differs from intent", async () => {
		const plan = await makePlan();
		const store = storage();
		const receipts = receiptStorage();
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => ({
				id: "row-1",
				data: { ...plan.commands[0]!.fields, title: "tampered" },
				revision: "rev-2",
				status: "published",
			})),
			create: vi.fn(async () => ({
				id: "row-1",
				data: plan.commands[0]!.fields,
				revision: "rev-1",
				status: "draft",
			})),
			update: vi.fn(),
			publish: vi.fn(async () => ({
				id: "row-1",
				data: plan.commands[0]!.fields,
				revision: "rev-2",
				status: "published",
			})),
			unpublish: vi.fn(),
		};
		expect(
			(
				await applySyncPlan(plan, {
					storage: { ...store, sync_receipts: receipts },
					content,
				} as never)
			).status,
		).toBe("failed");
		const receiptId = `${plan.trace.deliveryId}:${plan.commitSha}:${plan.planDigest}`;
		expect((receipts.rows.get(receiptId) as { state: string }).state).toBe("verification-failed");
	});

	it("does not mutate when receipt preparation cannot be persisted", async () => {
		const plan = await makePlan();
		const store = storage();
		const receipts = receiptStorage();
		receipts.create.mockRejectedValueOnce(new Error("receipt unavailable"));
		const content = {
			list: vi.fn(),
			get: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			publish: vi.fn(),
			unpublish: vi.fn(),
		};
		await expect(
			applySyncPlan(plan, { storage: { ...store, sync_receipts: receipts }, content } as never),
		).rejects.toThrow("receipt unavailable");
		expect(content.create).not.toHaveBeenCalled();
	});

	it("never reports success when post-apply receipt persistence fails", async () => {
		const plan = await makePlan();
		const store = storage();
		const receipts = receiptStorage();
		const originalPut = receipts.put;
		receipts.put = vi.fn(async (id: string, data: unknown) => {
			if (receipts.put.mock.calls.length === 2) throw new Error("post receipt unavailable");
			return originalPut(id, data);
		});
		const current = {
			id: "row-1",
			data: plan.commands[0]!.fields,
			revision: "rev-2",
			status: "published",
		};
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => current),
			create: vi.fn(async () => ({ ...current, revision: "rev-1", status: "draft" })),
			update: vi.fn(),
			publish: vi.fn(async () => current),
			unpublish: vi.fn(),
		};
		expect(
			(
				await applySyncPlan(plan, {
					storage: { ...store, sync_receipts: receipts },
					content,
				} as never)
			).status,
		).toBe("failed");
		expect(content.create).toHaveBeenCalledTimes(1);
	});

	it("creates, fences publication, checkpoints, and skips an exact replay", async () => {
		const plan = await makePlan();
		const store = storage();
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => ({
				id: "row-1",
				data: { contentId: "content-launch" },
				revision: "rev-2",
			})),
			create: vi.fn(async () => ({ id: "row-1", data: {}, revision: "rev-1" })),
			update: vi.fn(),
			publish: vi.fn(async () => ({ id: "row-1", data: {}, revision: "rev-2" })),
			unpublish: vi.fn(),
		};
		const ctx = { storage: store, content } as never;
		const first = await applySyncPlan(plan, ctx);
		const second = await applySyncPlan(plan, ctx);
		expect(first.status).toBe("succeeded");
		expect(second).toEqual(first);
		expect(content.create).toHaveBeenCalledTimes(1);
		expect(content.publish).toHaveBeenCalledWith("posts", "row-1", { expectedRevision: "rev-1" });
		const mappings = [...store.mappings.entries()].find(([id]) => id.includes("%7C"));
		expect(mappings).toBeDefined();
		expect(mappings?.[1]).toMatchObject({
			emdashId: "row-1",
			contentId: "content-launch",
			revision: "rev-2",
		});
	});

	it("returns conflict without publish or further mutation on a stale fenced update", async () => {
		const plan = await makePlan();
		plan.commands[0]!.expectedRevision = "stale-rev";
		await redigest(plan);
		const store = storage();
		const conflict = Object.assign(new Error("revision conflict"), {
			name: "PluginRevisionConflictError",
		});
		const content = {
			list: vi.fn(async () => ({
				items: [{ id: "row-1", data: { contentId: "content-launch" }, revision: "new-rev" }],
			})),
			get: vi.fn(async () => ({
				id: "row-1",
				data: { contentId: "content-launch" },
				revision: "new-rev",
			})),
			create: vi.fn(),
			update: vi.fn(async () => {
				throw conflict;
			}),
			publish: vi.fn(async () => ({ id: "new-row", data: {}, revision: "new-published" })),
			unpublish: vi.fn(),
		};
		const result = await applySyncPlan(plan, { storage: store, content } as never);
		expect(result.status).toBe("conflict");
		expect(content.publish).not.toHaveBeenCalled();
		expect(content.create).not.toHaveBeenCalled();
	});

	it("deduplicates concurrent identical applies and makes no removal delete call", async () => {
		const plan = await makePlan();
		const store = storage();
		let resolveCreate!: (value: {
			id: string;
			data: Record<string, unknown>;
			revision: string;
		}) => void;
		const create = vi.fn(
			() =>
				new Promise<{ id: string; data: Record<string, unknown>; revision: string }>((resolve) => {
					resolveCreate = resolve;
				}),
		);
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => ({
				id: "row-1",
				data: { contentId: "content-launch" },
				revision: "rev-1",
			})),
			create,
			update: vi.fn(),
			publish: vi.fn(async () => ({ id: "row-1", data: {}, revision: "rev-2" })),
			unpublish: vi.fn(),
			delete: vi.fn(),
		};
		const first = applySyncPlan(plan, { storage: store, content } as never);
		const second = applySyncPlan(plan, { storage: store, content } as never);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(create).toHaveBeenCalledTimes(1);
		resolveCreate({ id: "row-1", data: {}, revision: "rev-1" });
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(content.delete).not.toHaveBeenCalled();
	});

	it("runs identical plans independently for separate storage contexts", async () => {
		const plan = await makePlan();
		const firstStore = storage();
		const secondStore = storage();
		let started = 0;
		let release!: () => void;
		const bothStarted = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitForBoth = async () => {
			started += 1;
			if (started === 2) release();
			await bothStarted;
		};
		const makeContent = (rowId: string) => ({
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => ({ id: rowId, data: {}, revision: `${rowId}-published` })),
			create: vi.fn(async () => {
				await waitForBoth();
				return { id: rowId, data: {}, revision: `${rowId}-created` };
			}),
			update: vi.fn(),
			publish: vi.fn(async () => ({ id: rowId, data: {}, revision: `${rowId}-published` })),
			unpublish: vi.fn(),
		});
		const firstContent = makeContent("first-row");
		const secondContent = makeContent("second-row");
		const first = applySyncPlan(plan, { storage: firstStore, content: firstContent } as never);
		const second = applySyncPlan(plan, { storage: secondStore, content: secondContent } as never);
		let timeoutId!: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error("contexts were incorrectly coalesced")), 1_000);
		});
		const [firstResult, secondResult] = await Promise.race([Promise.all([first, second]), timeout]);
		clearTimeout(timeoutId);
		expect(started).toBe(2);
		expect(firstContent.create).toHaveBeenCalledTimes(1);
		expect(secondContent.create).toHaveBeenCalledTimes(1);
		expect(firstResult.results[0]?.contentId).toBe("content-launch");
		expect(secondResult.results[0]?.contentId).toBe("content-launch");
		expect(firstStore.records.size).toBe(1);
		expect(secondStore.records.size).toBe(1);
		expect(firstStore.mappings.values().next().value).toMatchObject({ emdashId: "first-row" });
		expect(secondStore.mappings.values().next().value).toMatchObject({ emdashId: "second-row" });
	});

	it("does not leak a rejected run between storage contexts, allowing a retry", async () => {
		const plan = await makePlan();
		const failedStore = storage();
		const successfulStore = storage();
		const failedContent = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => ({ id: "failed-row", data: {}, revision: "rev" })),
			create: vi.fn(async () => {
				throw new Error("context-local failure");
			}),
			update: vi.fn(),
			publish: vi.fn(),
			unpublish: vi.fn(),
		};
		const successfulContent = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => ({ id: "successful-row", data: {}, revision: "rev-published" })),
			create: vi.fn(async () => ({ id: "successful-row", data: {}, revision: "rev-created" })),
			update: vi.fn(),
			publish: vi.fn(async () => ({ id: "successful-row", data: {}, revision: "rev-published" })),
			unpublish: vi.fn(),
		};
		const failed = await applySyncPlan(plan, {
			storage: failedStore,
			content: failedContent,
		} as never);
		const successful = await applySyncPlan(plan, {
			storage: successfulStore,
			content: successfulContent,
		} as never);
		expect(failed.status).toBe("failed");
		expect(successful.status).toBe("succeeded");
		expect(successfulContent.create).toHaveBeenCalledTimes(1);
	});

	it("keeps different plans independent within one storage context", async () => {
		const firstPlan = await makePlan();
		const secondPlan = await buildSyncPlan({ ...input, deliveryId: "delivery-10" }, planFetcher);
		secondPlan.commands[0]!.source.path = "content/other.md";
		secondPlan.commands[0]!.contentId = "content-other";
		secondPlan.commands[0]!.fields.contentId = "content-other";
		await redigest(secondPlan);
		const store = storage();
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => ({ id: "row", data: {}, revision: "rev-published" })),
			create: vi
				.fn()
				.mockResolvedValueOnce({ id: "first-row", data: {}, revision: "first-rev" })
				.mockResolvedValueOnce({ id: "second-row", data: {}, revision: "second-rev" }),
			update: vi.fn(),
			publish: vi
				.fn()
				.mockResolvedValueOnce({ id: "first-row", data: {}, revision: "first-published" })
				.mockResolvedValueOnce({ id: "second-row", data: {}, revision: "second-published" }),
			unpublish: vi.fn(),
		};
		const [first, second] = await Promise.all([
			applySyncPlan(firstPlan, { storage: store, content } as never),
			applySyncPlan(secondPlan, { storage: store, content } as never),
		]);
		expect(first.status).toBe("succeeded");
		expect(second.status).toBe("succeeded");
		expect(content.create).toHaveBeenCalledTimes(2);
		expect(store.records.size).toBe(2);
	});

	it("uses the canonical mapping revision instead of scanning the first 100 rows", async () => {
		const plan = await makePlan();
		plan.commands[0]!.expectedRevision = "attacker-revision";
		await redigest(plan);
		const store = storage();
		const mappingKey = encodeURIComponent(`${repository}|refs/heads/main|content/post.md|en`);
		store.sync_mappings.put(mappingKey, {
			sourceKey: mappingKey,
			repository,
			branch: "refs/heads/main",
			sourcePath: "content/post.md",
			locale: "en",
			contentId: "content-launch",
			collection: "posts",
			emdashId: "row-101",
			lastCommitSha: sha,
			lastPlanDigest: plan.planDigest,
			revision: "mapped-rev",
			route: "/posts/launch/",
			publication: "published",
			mediaIds: [],
			attemptId: "old",
			status: "active",
		});
		const content = {
			list: vi.fn(),
			get: vi.fn(async () => ({
				id: "row-101",
				data: { contentId: "content-launch" },
				revision: "mapped-rev",
			})),
			create: vi.fn(),
			update: vi.fn(),
			publish: vi.fn(),
			unpublish: vi.fn(),
		};
		const result = await applySyncPlan(plan, { storage: store, content } as never);
		expect(result.status).toBe("conflict");
		expect(content.list).not.toHaveBeenCalled();
		expect(content.update).not.toHaveBeenCalled();
	});

	it("rejects corrupt direct and fallback mappings before content mutation", async () => {
		const plan = await makePlan();
		const store = storage();
		const key = encodeURIComponent(`${repository}|refs/heads/main|content/post.md|en`);
		store.mappings.set(key, {
			sourceKey: key,
			repository: "evil/other",
			branch: "refs/heads/main",
			sourcePath: "content/post.md",
			locale: "en",
			contentId: "content-launch",
			collection: "posts",
			emdashId: "other-row",
			lastCommitSha: sha,
			lastPlanDigest: plan.planDigest,
			revision: "rev",
			route: "/",
			publication: "published",
			mediaIds: [],
			attemptId: "x",
			status: "active",
		});
		const content = {
			list: vi.fn(async () => ({
				items: [{ id: "row-1", data: { contentId: "content-launch" }, revision: "rev" }],
			})),
			get: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			publish: vi.fn(),
			unpublish: vi.fn(),
		};
		const result = await applySyncPlan(plan, { storage: store, content } as never);
		expect(result.status).toBe("conflict");
		expect(content.get).not.toHaveBeenCalled();
		expect(content.update).not.toHaveBeenCalled();
	});

	it("fetches media at the immutable commit and links deduplicated media IDs", async () => {
		const plan = await makePlan();
		const media = {
			sourcePath: "assets/hero.png",
			sha256: "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
			mimeType: "image/png",
			bytes: 8,
			width: 1,
			height: 1,
			alt: "Hero",
		};
		plan.commands[0]!.media = [media];
		plan.mediaManifest = JSON.stringify({ schemaVersion: 1, media: [media] });
		await redigest(plan);
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const fetch = vi.fn(
			async (_url: string) => new Response(png, { headers: { "content-type": "image/png" } }),
		);
		const store = storage();
		const receipts = receiptStorage();
		const persistedData = { ...plan.commands[0]!.fields, mediaIds: ["media-1"] };
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async () => ({
				id: "row-1",
				data: persistedData,
				revision: "rev-2",
				status: "published",
			})),
			create: vi.fn(async (_collection: string, fields: Record<string, unknown>) => {
				expect(fields.mediaIds).toEqual(["media-1"]);
				return { id: "row-1", data: fields, revision: "rev-1" };
			}),
			update: vi.fn(),
			publish: vi.fn(async () => ({
				id: "row-1",
				data: persistedData,
				revision: "rev-2",
				status: "published",
			})),
			unpublish: vi.fn(),
		};
		const mediaAccess = {
			get: vi.fn(async () => ({ id: "media-1", sha256: media.sha256 })),
			upload: vi.fn(async () => ({
				mediaId: "media-1",
				storageKey: "media-1.png",
				url: "/media/media-1",
			})),
		};
		await applySyncPlan(plan, {
			storage: { ...store, sync_receipts: receipts },
			content,
			media: mediaAccess,
			http: { fetch },
		} as never);
		expect(fetch).toHaveBeenCalledWith(
			`https://raw.githubusercontent.com/${repository}/${sha}/assets/hero.png`,
			{ method: "GET", redirect: "error" },
		);
		expect(mediaAccess.upload).toHaveBeenCalledWith(
			"assets/hero.png",
			"image/png",
			expect.any(ArrayBuffer),
			expect.objectContaining({ deduplicate: true }),
		);
		expect(mediaAccess.get).toHaveBeenCalledWith("media-1");
		const mismatchedStore = storage();
		const mismatchedReceipts = receiptStorage();
		const mismatchedMedia = {
			...mediaAccess,
			get: vi.fn(async () => ({ id: "media-1", sha256: "0".repeat(64) })),
		};
		expect(
			(
				await applySyncPlan(plan, {
					storage: { ...mismatchedStore, sync_receipts: mismatchedReceipts },
					content,
					media: mismatchedMedia,
					http: { fetch },
				} as never)
			).status,
		).toBe("failed");
	});

	it("fails closed on corrupt replay records without returning stored secrets", async () => {
		const plan = await makePlan();
		const store = storage();
		store.records.set(`${input.deliveryId}:${sha}:${plan.planDigest}`, {
			status: "succeeded",
			planDigest: plan.planDigest,
			warnings: [{ secret: "do-not-return" }],
		});
		await expect(applySyncPlan(plan, { storage: store } as never)).rejects.toThrow(
			"GITHUB_SYNC_APPLY_REPLAY_RECORD",
		);
	});

	it("unpublishes a mapped removal and marks it quarantined without deleting", async () => {
		const removalInput = {
			...input,
			previous: [{ path: "content/old.md", contentId: "content-old", contentHash: "f".repeat(64) }],
		};
		const plan = await buildSyncPlan(removalInput, planFetcher);
		const store = storage();
		const oldKey = encodeURIComponent(`${repository}|refs/heads/main|content/old.md|en`);
		store.mappings.set(oldKey, {
			sourceKey: oldKey,
			repository,
			branch: "refs/heads/main",
			sourcePath: "content/old.md",
			locale: "en",
			contentId: "content-old",
			collection: "posts",
			emdashId: "old-row",
			lastCommitSha: sha,
			lastPlanDigest: plan.planDigest,
			revision: "old-rev",
			route: "/posts/old/",
			publication: "published",
			mediaIds: [],
			attemptId: "old-attempt",
			status: "active",
		});
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async (_collection: string, id: string) =>
				id === "old-row"
					? { id, data: { contentId: "content-old" }, revision: "old-rev" }
					: { id, data: {}, revision: "new-rev" },
			),
			create: vi.fn(async () => ({ id: "new-row", data: {}, revision: "new-rev" })),
			update: vi.fn(),
			publish: vi.fn(async () => ({ id: "new-row", data: {}, revision: "new-published" })),
			unpublish: vi.fn(async () => ({ id: "old-row", data: {}, revision: "old-unpublished" })),
		};
		const result = await applySyncPlan(plan, { storage: store, content } as never);
		expect(result.status).toBe("succeeded");
		expect(content.unpublish).toHaveBeenCalledWith("posts", "old-row", {
			expectedRevision: "old-rev",
		});
		expect(store.mappings.get(oldKey)).toMatchObject({
			status: "quarantined",
			publication: "unpublished",
		});
	});

	it("reconciles a removal when checkpoint persistence fails after unpublish", async () => {
		const removalInput = {
			...input,
			previous: [{ path: "content/old.md", contentId: "content-old", contentHash: "f".repeat(64) }],
		};
		const plan = await buildSyncPlan(removalInput, planFetcher);
		const store = storage();
		const oldKey = encodeURIComponent(`${repository}|refs/heads/main|content/old.md|en`);
		store.mappings.set(oldKey, {
			sourceKey: oldKey,
			repository,
			branch: "refs/heads/main",
			sourcePath: "content/old.md",
			locale: "en",
			contentId: "content-old",
			collection: "posts",
			emdashId: "old-row",
			lastCommitSha: sha,
			lastPlanDigest: plan.planDigest,
			revision: "old-rev",
			route: "/posts/old/",
			publication: "published",
			mediaIds: [],
			attemptId: "old-attempt",
			status: "active",
		});
		let unpublished = false;
		const originalPut = store.sync_mappings.put;
		store.sync_mappings.put = vi.fn(async (id: string, data: unknown) => {
			if ((data as { status?: string }).status === "quarantined" && !unpublished) {
				unpublished = true;
				throw new Error("checkpoint unavailable");
			}
			return originalPut(id, data);
		});
		const content = {
			list: vi.fn(async () => ({ items: [] })),
			get: vi.fn(async (_collection: string, id: string) =>
				id === "old-row"
					? unpublished
						? { id, data: {}, revision: "old-unpublished", status: "draft" }
						: { id, data: {}, revision: "old-rev", status: "published" }
					: { id, data: {}, revision: "new-rev" },
			),
			create: vi.fn(async () => ({ id: "new-row", data: {}, revision: "new-rev" })),
			update: vi.fn(),
			publish: vi.fn(async () => ({ id: "new-row", data: {}, revision: "new-published" })),
			unpublish: vi.fn(async () => ({
				id: "old-row",
				data: {},
				revision: "old-unpublished",
				status: "draft",
			})),
		};
		await expect(applySyncPlan(plan, { storage: store, content } as never)).rejects.toThrow(
			"checkpoint unavailable",
		);
		const result = await applySyncPlan(plan, { storage: store, content } as never);
		expect(result.status).toBe("succeeded");
		expect(content.unpublish).toHaveBeenCalledTimes(1);
		expect(store.mappings.get(oldKey)).toMatchObject({
			revision: "old-unpublished",
			status: "quarantined",
		});
	});
});
