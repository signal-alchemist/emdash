import { beforeEach, describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({
	calls: [] as Array<[string, unknown[]]>,
	writes: 0,
}));

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

vi.mock("emdash", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash")>();
	const item = (revision: string, status = "draft") => ({
		id: "post-1",
		type: "posts",
		slug: "next-slug",
		status,
		data: { title: "next" },
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		locale: "en",
		publishedAt: null,
		scheduledAt: null,
		revision,
	});
	return {
		...actual,
		createContentAccessWithWrite: (_db: unknown, beforeWrite?: () => Promise<void>) => ({
			update: async (...args: unknown[]) => {
				await beforeWrite?.();
				mutation.calls.push(["update", args]);
				if ((args[3] as { expectedRevision?: string } | undefined)?.expectedRevision === "stale") {
					throw new actual.PluginRevisionConflictError();
				}
				mutation.writes += 1;
				return item("rev-2");
			},
			publish: async (...args: unknown[]) => {
				await beforeWrite?.();
				mutation.calls.push(["publish", args]);
				mutation.writes += 1;
				return item("rev-3", "published");
			},
			unpublish: async (...args: unknown[]) => {
				await beforeWrite?.();
				mutation.calls.push(["unpublish", args]);
				mutation.writes += 1;
				return item("rev-4");
			},
		}),
	};
});

import { PluginBridge } from "../../src/sandbox/bridge.js";

function makeBridge(capabilities = ["content:write"]) {
	const db = {
		prepare() {
			return {
				bind() {
					return this;
				},
				async first() {
					throw new Error("D1_ERROR: no such table: _emdash_media_usage_activation");
				},
			};
		},
	};
	return new PluginBridge(
		{
			props: {
				pluginId: "plugin",
				pluginVersion: "1.0.0",
				capabilities,
				allowedHosts: [],
				storageCollections: [],
			},
		} as never,
		{ DB: db } as never,
	);
}

describe("PluginBridge revision-aware content mutations", () => {
	beforeEach(() => {
		mutation.calls.length = 0;
		mutation.writes = 0;
	});

	it("forwards update, publish, and unpublish options and revisions", async () => {
		const bridge = makeBridge();
		await expect(
			bridge.contentUpdate(
				"posts",
				"post-1",
				{ title: "next" },
				{
					expectedRevision: "rev-1",
					slug: "next-slug",
				},
			),
		).resolves.toMatchObject({ revision: "rev-2", slug: "next-slug" });
		await expect(
			bridge.contentPublish("posts", "post-1", {
				expectedRevision: "rev-2",
				publishedAt: "2026-08-25T00:00:00.000Z",
			}),
		).resolves.toMatchObject({ revision: "rev-3", status: "published" });
		await expect(
			bridge.contentUnpublish("posts", "post-1", { expectedRevision: "rev-3" }),
		).resolves.toMatchObject({ revision: "rev-4", status: "draft" });
		expect(mutation.calls).toEqual([
			[
				"update",
				["posts", "post-1", { title: "next" }, { expectedRevision: "rev-1", slug: "next-slug" }],
			],
			[
				"publish",
				["posts", "post-1", { expectedRevision: "rev-2", publishedAt: "2026-08-25T00:00:00.000Z" }],
			],
			["unpublish", ["posts", "post-1", { expectedRevision: "rev-3" }]],
		]);
	});

	it("fails stale and malformed options closed without mutation", async () => {
		const bridge = makeBridge();
		await expect(
			bridge.contentUpdate("posts", "post-1", {}, { expectedRevision: "stale" }),
		).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
		expect(mutation.writes).toBe(0);
		await expect(
			bridge.contentPublish("posts", "post-1", { publishedAt: false } as never),
		).rejects.toThrow(/invalid content publish options/i);
		await expect(
			bridge.contentUnpublish("posts", "post-1", { unknown: true } as never),
		).rejects.toThrow(/invalid content unpublish options/i);
		expect(mutation.writes).toBe(0);
	});

	it("requires content:write for every mutation", async () => {
		const bridge = makeBridge([]);
		await expect(bridge.contentUpdate("posts", "post-1", {})).rejects.toThrow(
			"Missing capability: content:write",
		);
		await expect(bridge.contentPublish("posts", "post-1")).rejects.toThrow(
			"Missing capability: content:write",
		);
		await expect(bridge.contentUnpublish("posts", "post-1")).rejects.toThrow(
			"Missing capability: content:write",
		);
		expect(mutation.calls).toHaveLength(0);
	});
});
