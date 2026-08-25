import { describe, expect, it } from "vitest";

import { githubContentSyncPlugin } from "../src/index.js";
import {
	contentHash,
	listSyncReceipts,
	prepareSyncReceipt,
	persistSyncReceipt,
	readSyncReceipt,
	rollbackSyncReceipt,
	toReceiptView,
	verifySyncReceipt,
} from "../src/receipts.js";

const plan = {
	version: 1,
	repository: "signal-alchemist/site",
	commitSha: "a".repeat(40),
	branch: "refs/heads/main",
	actions: [],
	catalog: [],
	contentCatalog: "",
	mediaManifest: "",
	commands: [
		{
			operation: "upsert",
			collection: "posts",
			contentId: "content-a",
			source: {
				repository: "signal-alchemist/site",
				branch: "refs/heads/main",
				path: "content/a.md",
				commitSha: "a".repeat(40),
				deliveryId: "delivery-1",
			},
			fields: { title: "A" },
			media: [],
			publishState: "draft",
		},
	],
	trace: {
		deliveryId: "delivery-1",
		event: "pull_request",
		repository: "signal-alchemist/site",
		branch: "refs/heads/main",
		commitSha: "a".repeat(40),
		actorId: "7",
		pullRequestNumber: 1,
		filesUrl: "https://api.github.com/repos/signal-alchemist/site/pulls/1/files",
	},
	totalFetchedBytes: 0,
	totalPlanBytes: 0,
	planDigest: "b".repeat(64),
	planDigestScope: "core-plan-v1",
} as never;

function store() {
	const map = new Map<string, unknown>();
	return {
		map,
		get: async (id: string) => (map.has(id) ? { id, data: map.get(id) } : null),
		create: async (id: string, data: unknown) => {
			if (map.has(id)) return false;
			map.set(id, structuredClone(data));
			return true;
		},
		put: async (id: string, data: unknown) => {
			map.set(id, structuredClone(data));
		},
		delete: async (id: string) => map.delete(id),
		query: async () => ({ items: Array.from(map.entries(), ([id, data]) => ({ id, data })) }),
	};
}

describe("sync receipts", () => {
	it("persists bounded metadata and rejects duplicate ownership", async () => {
		const receipt = await prepareSyncReceipt(plan, "7");
		const storage = store();
		expect(await persistSyncReceipt(storage, receipt)).toBe(true);
		expect(await persistSyncReceipt(storage, receipt)).toBe(false);
		expect(
			(await readSyncReceipt(storage, receipt.receiptId))?.operations[0]?.intendedDigest,
		).toMatch(/^[0-9a-f]{64}$/);
		const protectedHash = await contentHash({ token: "one", title: "A" });
		expect(protectedHash).not.toBe(await contentHash({ token: "two", title: "A" }));
	});
	it("never exposes rollback snapshot values in receipt views", async () => {
		const receipt = await prepareSyncReceipt(plan, "7");
		const view = toReceiptView({
			...receipt,
			operations: [
				{
					...receipt.operations[0]!,
					rollback: {
						data: { token: "actual-secret-value", password: "hidden" },
						publication: "draft",
					},
				},
			],
		});
		expect(JSON.stringify(view)).not.toContain("actual-secret-value");
		expect(JSON.stringify(view)).not.toContain("hidden");
		expect(view.operations[0]?.rollback).toEqual({ publication: "draft" });
	});
	it("elects one durable receipt owner across contexts", async () => {
		const storage = store();
		const left = await prepareSyncReceipt(plan, "7");
		const right = structuredClone(left);
		expect(
			await Promise.all([persistSyncReceipt(storage, left), persistSyncReceipt(storage, right)]),
		).toEqual([true, false]);
		expect((await readSyncReceipt(storage, left.receiptId))?.planDigest).toBe("b".repeat(64));
	});
	it("verifies canonical read-back and fences rollback", async () => {
		const storage = store();
		const receipt = await prepareSyncReceipt(plan, "7");
		const content = {
			row: { id: "row-1", data: { title: "A" }, revision: "rev-2", status: "draft" },
			get: async () => content.row,
			update: async (_c: string, _id: string, data: Record<string, unknown>) => {
				content.row = { ...content.row, data, revision: "rev-3" };
				return content.row;
			},
		};
		const verified = await verifySyncReceipt(
			{
				...receipt,
				operations: [
					{
						...receipt.operations[0]!,
						pre: {
							id: "row-1",
							revision: "rev-1",
							hash: await contentHash({ title: "old" }),
							status: "draft",
						},
						rollback: { data: { title: "old" }, publication: "draft" },
					},
				],
			},
			content,
		);
		expect(verified.state).toBe("verified");
		const rolled = await rollbackSyncReceipt(
			storage,
			{ ...verified, state: "rollback-eligible" },
			content,
			"7",
			"reviewed",
		);
		expect(rolled.state).toBe("rolled-back");
		expect(content.row.revision).toBe("rev-3");
	});
	it("allows one concurrent rollback and preserves its persisted winner", async () => {
		const storage = store();
		const base = await prepareSyncReceipt(plan, "7");
		const receipt = {
			...base,
			state: "rollback-eligible" as const,
			operations: [
				{
					...base.operations[0]!,
					pre: {
						id: "row-1",
						revision: "rev-1",
						hash: await contentHash({ title: "old" }),
						status: "draft",
					},
					post: {
						id: "row-1",
						revision: "rev-2",
						hash: await contentHash({ title: "A" }),
						status: "draft",
					},
					rollback: { data: { title: "old" }, publication: "draft" },
				},
			],
		};
		await persistSyncReceipt(storage, receipt);
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const content = {
			row: { id: "row-1", data: { title: "A" }, revision: "rev-2", status: "draft" },
			get: async () => content.row,
			update: async (_c: string, _id: string, data: Record<string, unknown>) => {
				started();
				await gate;
				content.row = { ...content.row, data, revision: "rev-3" };
				return content.row;
			},
			unpublish: async () => content.row,
			publish: async () => content.row,
		};
		const winner = rollbackSyncReceipt(storage, receipt, content, "7", "approved");
		await entered;
		await expect(rollbackSyncReceipt(storage, receipt, content, "8", "competing")).rejects.toThrow(
			"ROLLBACK_IN_PROGRESS",
		);
		release();
		expect((await winner).state).toBe("rolled-back");
		expect((await readSyncReceipt(storage, receipt.receiptId))?.rollback?.reviewedBy).toBe("7");
	});
	it("quarantines a newly created item instead of deleting it", async () => {
		const storage = store();
		const base = await prepareSyncReceipt(plan, "7");
		const receipt = {
			...base,
			state: "rollback-eligible" as const,
			operations: [
				{
					...base.operations[0]!,
					post: {
						id: "new-row",
						revision: "rev-1",
						hash: await contentHash({ title: "A" }),
						status: "published",
					},
				},
			],
		};
		let row = { id: "new-row", data: { title: "A" }, revision: "rev-1", status: "published" };
		const content = {
			get: async () => row,
			update: async () => row,
			unpublish: async () => {
				row = { ...row, revision: "rev-2", status: "unpublished" };
				return row;
			},
		};
		expect((await rollbackSyncReceipt(storage, receipt, content, "7", "quarantine")).state).toBe(
			"rolled-back",
		);
		expect(row.status).toBe("unpublished");
	});
	it("persists rollback failure, releases its durable claim, and allows retry", async () => {
		const storage = store();
		const base = await prepareSyncReceipt(plan, "7");
		const receipt = {
			...base,
			state: "rollback-eligible" as const,
			operations: [
				{
					...base.operations[0]!,
					pre: {
						id: "row-1",
						revision: "rev-1",
						hash: await contentHash({ title: "old" }),
						status: "draft",
					},
					post: {
						id: "row-1",
						revision: "rev-2",
						hash: await contentHash({ title: "A" }),
						status: "draft",
					},
					rollback: { data: { title: "old" }, publication: "draft" },
				},
			],
		};
		await persistSyncReceipt(storage, receipt);
		let fail = true;
		let row = { id: "row-1", data: { title: "A" }, revision: "rev-2", status: "draft" };
		const content = {
			get: async () => row,
			update: async (_c: string, _id: string, data: Record<string, unknown>) => {
				if (fail) throw new Error("write unavailable");
				row = { ...row, data, revision: "rev-3" };
				return row;
			},
			unpublish: async () => row,
		};
		await expect(rollbackSyncReceipt(storage, receipt, content, "7", "approved")).rejects.toThrow(
			"write unavailable",
		);
		expect((await readSyncReceipt(storage, receipt.receiptId))?.state).toBe("rollback-failed");
		fail = false;
		expect(
			(
				await rollbackSyncReceipt(
					storage,
					{ ...receipt, state: "rollback-failed" },
					content,
					"7",
					"retry",
				)
			).state,
		).toBe("rolled-back");
	});
	it("checkpoints each operation so partial rollback retry skips the completed mutation", async () => {
		const storage = store();
		const base = await prepareSyncReceipt(plan, "7");
		const makeOperation = async (index: number, id: string) => ({
			...base.operations[0]!,
			index,
			contentId: id,
			pre: {
				id,
				revision: "rev-1",
				hash: await contentHash({ title: `old-${id}` }),
				status: "draft",
			},
			post: {
				id,
				revision: "rev-2",
				hash: await contentHash({ title: `new-${id}` }),
				status: "draft",
			},
			rollback: { data: { title: `old-${id}` }, publication: "draft" },
		});
		const receipt = {
			...base,
			state: "rollback-eligible" as const,
			operations: [await makeOperation(0, "row-1"), await makeOperation(1, "row-2")],
		};
		await persistSyncReceipt(storage, receipt);
		const rows = new Map([
			["row-1", { id: "row-1", data: { title: "new-row-1" }, revision: "rev-2", status: "draft" }],
			["row-2", { id: "row-2", data: { title: "new-row-2" }, revision: "rev-2", status: "draft" }],
		]);
		const calls = new Map<string, number>();
		let failSecond = true;
		const content = {
			get: async (_collection: string, id: string) => rows.get(id) ?? null,
			update: async (_collection: string, id: string, data: Record<string, unknown>) => {
				calls.set(id, (calls.get(id) ?? 0) + 1);
				if (id === "row-2" && failSecond) throw new Error("second unavailable");
				const next = { id, data, revision: "rev-3", status: "draft" };
				rows.set(id, next);
				return next;
			},
			unpublish: async (_collection: string, id: string) => rows.get(id)!,
		};
		await expect(rollbackSyncReceipt(storage, receipt, content, "7", "partial")).rejects.toThrow(
			"second unavailable",
		);
		expect(
			(await readSyncReceipt(storage, receipt.receiptId))?.operations[0]?.rollbackResult?.state,
		).toBe("completed");
		failSecond = false;
		expect((await rollbackSyncReceipt(storage, receipt, content, "7", "retry")).state).toBe(
			"rolled-back",
		);
		expect(calls.get("row-1")).toBe(1);
		expect(calls.get("row-2")).toBe(2);
	});
	it("converges by finalization-only retry when the rolled-back receipt write fails", async () => {
		const storage = store();
		const base = await prepareSyncReceipt(plan, "7");
		const receipt = {
			...base,
			state: "rollback-eligible" as const,
			operations: [
				{
					...base.operations[0]!,
					pre: {
						id: "row-1",
						revision: "rev-1",
						hash: await contentHash({ title: "old" }),
						status: "draft",
					},
					post: {
						id: "row-1",
						revision: "rev-2",
						hash: await contentHash({ title: "new" }),
						status: "draft",
					},
					rollback: { data: { title: "old" }, publication: "draft" },
				},
			],
		};
		await persistSyncReceipt(storage, receipt);
		let row = { id: "row-1", data: { title: "new" }, revision: "rev-2", status: "draft" };
		let updates = 0;
		const content = {
			get: async () => row,
			update: async (_c: string, _id: string, data: Record<string, unknown>) => {
				updates += 1;
				row = { ...row, data, revision: "rev-3" };
				return row;
			},
			unpublish: async () => row,
		};
		const put = storage.put;
		let failFinal = true;
		storage.put = async (id: string, data: unknown) => {
			if (failFinal && (data as { state?: string }).state === "rolled-back")
				throw new Error("final unavailable");
			await put(id, data);
		};
		await expect(rollbackSyncReceipt(storage, receipt, content, "7", "approved")).rejects.toThrow(
			"final unavailable",
		);
		failFinal = false;
		expect((await rollbackSyncReceipt(storage, receipt, content, "7", "finalize")).state).toBe(
			"rolled-back",
		);
		expect(updates).toBe(1);
	});
	it("checkpoints restored content before publication so publish failure retry does not update twice", async () => {
		const storage = store();
		const base = await prepareSyncReceipt(plan, "7");
		const receipt = {
			...base,
			state: "rollback-eligible" as const,
			operations: [
				{
					...base.operations[0]!,
					pre: {
						id: "row-1",
						revision: "rev-1",
						hash: await contentHash({ title: "old" }),
						status: "published",
					},
					post: {
						id: "row-1",
						revision: "rev-2",
						hash: await contentHash({ title: "new" }),
						status: "draft",
					},
					rollback: { data: { title: "old" }, publication: "published" },
				},
			],
		};
		await persistSyncReceipt(storage, receipt);
		let row = { id: "row-1", data: { title: "new" }, revision: "rev-2", status: "draft" };
		let updates = 0;
		let publishes = 0;
		const content = {
			get: async () => row,
			update: async (_c: string, _id: string, data: Record<string, unknown>) => {
				updates += 1;
				row = { ...row, data, revision: "rev-3" };
				return row;
			},
			publish: async () => {
				publishes += 1;
				if (publishes === 1) throw new Error("publish unavailable");
				row = { ...row, revision: "rev-4", status: "published" };
				return row;
			},
			unpublish: async () => row,
		};
		await expect(rollbackSyncReceipt(storage, receipt, content, "7", "restore")).rejects.toThrow(
			"publish unavailable",
		);
		expect(
			(await readSyncReceipt(storage, receipt.receiptId))?.operations[0]?.rollbackResult?.state,
		).toBe("content-restored");
		expect((await rollbackSyncReceipt(storage, receipt, content, "7", "retry")).state).toBe(
			"rolled-back",
		);
		expect(updates).toBe(1);
		expect(publishes).toBe(2);
	});
	it("fails closed on corrupt and oversized receipt rows", async () => {
		const storage = store();
		storage.map.set("bad", { version: 1, secret: "do-not-return" });
		await expect(readSyncReceipt(storage, "bad")).rejects.toThrow("CORRUPT");
		const receipt = await prepareSyncReceipt(plan, "7");
		storage.map.set(receipt.receiptId, {
			...receipt,
			operations: Array.from({ length: 513 }).fill(receipt.operations[0]),
		});
		await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow("CORRUPT");
		storage.map.set(receipt.receiptId, { ...receipt, unknown: true });
		await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow("CORRUPT");
		storage.map.set(receipt.receiptId, {
			...receipt,
			operations: [{ ...receipt.operations[0], post: Object.create({ id: "inherited" }) }],
		});
		await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow("CORRUPT");
		const accessor = { ...receipt } as Record<string, unknown>;
		Object.defineProperty(accessor, "state", { enumerable: true, get: () => "prepared" });
		storage.map.set(receipt.receiptId, accessor);
		await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow("CORRUPT");
		storage.map.set(receipt.receiptId, { ...receipt, createdAt: "not-a-date" });
		await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow("CORRUPT");
	});
	it("canonicalizes rollback snapshots and rejects corrupt nested data without invoking getters", async () => {
		const storage = store();
		const receipt = await prepareSyncReceipt(plan, "7");
		const validData = { nested: { title: "prior" } };
		const withRollback = (data: unknown) => ({
			...receipt,
			operations: [
				{
					...receipt.operations[0],
					rollback: { data, publication: "draft" },
				},
			],
		});
		storage.map.set(receipt.receiptId, withRollback(validData));
		const restored = await readSyncReceipt(storage, receipt.receiptId);
		expect(restored?.operations[0]?.rollback?.data).toEqual(validData);
		expect(restored?.operations[0]?.rollback?.data).not.toBe(validData);

		let getterCalls = 0;
		const accessor: Record<string, unknown> = {};
		Object.defineProperty(accessor, "token", {
			enumerable: true,
			get: () => {
				getterCalls += 1;
				return "must-not-be-read";
			},
		});
		storage.map.set(receipt.receiptId, withRollback({ nested: accessor }));
		await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow(
			"GITHUB_SYNC_RECEIPT_CORRUPT",
		);
		expect(getterCalls).toBe(0);

		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const data of [
			{ nested: cycle },
			{ nested: Object.create({ inherited: true }) },
			{ amount: 1n },
			{ amount: Number.NaN },
		]) {
			storage.map.set(receipt.receiptId, withRollback(data));
			await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow(
				"GITHUB_SYNC_RECEIPT_CORRUPT",
			);
		}

		let tooDeep: Record<string, unknown> = {};
		for (let index = 0; index < 18; index += 1) tooDeep = { nested: tooDeep };
		storage.map.set(receipt.receiptId, withRollback(tooDeep));
		await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow(
			"GITHUB_SYNC_RECEIPT_CORRUPT",
		);
		storage.map.set(receipt.receiptId, withRollback({ body: "x".repeat(120_000) }));
		await expect(readSyncReceipt(storage, receipt.receiptId)).rejects.toThrow(
			"GITHUB_SYNC_RECEIPT_OVERSIZE",
		);
	});
	it("fails integrity hashing closed for cycles, prototypes, accessors, bigint, and oversize", async () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		await expect(contentHash(cycle)).rejects.toThrow("CONTENT_INVALID");
		await expect(contentHash(Object.create({ inherited: true }))).rejects.toThrow(
			"CONTENT_INVALID",
		);
		const accessor: Record<string, unknown> = {};
		Object.defineProperty(accessor, "token", { enumerable: true, get: () => "secret" });
		await expect(contentHash(accessor)).rejects.toThrow("CONTENT_INVALID");
		await expect(contentHash({ amount: 1n })).rejects.toThrow();
		await expect(contentHash({ body: "x".repeat(2_000_001) })).rejects.toThrow("CONTENT_OVERSIZE");
	});
	it("declares the exact durable receipt indexes in the runtime descriptor", () => {
		expect(githubContentSyncPlugin().storage.sync_receipts).toEqual({
			indexes: ["deliveryId", "commitSha", "planDigest", "state", "createdAt", "trustedActorId"],
		});
		expect(githubContentSyncPlugin().capabilities).toContain("media:read");
	});
	it("lists equal timestamps deterministically and hides internal claims", async () => {
		const storage = store();
		const first = await prepareSyncReceipt(plan, "7", "2026-08-25T00:00:00.000Z");
		const second = {
			...first,
			receiptId: `${first.receiptId.slice(0, -1)}c`,
			planDigest: "c".repeat(64),
		};
		await storage.put(second.receiptId, second);
		await storage.put(first.receiptId, first);
		await storage.put("apply:internal", { kind: "apply-claim", secret: "hidden" });
		const listed = await listSyncReceipts(storage, { limit: 10 });
		expect(listed.items.map((item) => item.id)).toEqual([first.receiptId, second.receiptId]);
		expect(JSON.stringify(listed)).not.toContain("hidden");
		expect(await readSyncReceipt(storage, "unknown")).toBeNull();
	});
});
