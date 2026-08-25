import { describe, expect, it, vi } from "vitest";
import {
	assertStorageCollectionDeclared,
	storageCreate,
} from "../../src/sandbox/storage-create.js";

function makeDatabase(changes: number) {
	const prepared = {
		bind: vi.fn(() => prepared),
		run: vi.fn(async () => ({ meta: { changes } })),
	};
	const prepare = vi.fn((_sql: string) => prepared);
	const DB = { prepare };
	return { DB, prepared, prepare };
}

describe("PluginBridge storageCreate D1 helper", () => {
	it("uses an idempotent declared-collection insert and reports D1 changes", async () => {
		for (const changes of [1, 0]) {
			const { DB, prepared, prepare } = makeDatabase(changes);
			expect(await storageCreate(DB, "plugin", "items", "one", { ok: true })).toBe(changes === 1);
			expect(prepare.mock.calls[0]?.[0]).toContain(
				"ON CONFLICT(plugin_id, collection, id) DO NOTHING",
			);
			expect(prepared.bind).toHaveBeenCalledWith("plugin", "items", "one", '{"ok":true}');
		}
	});

	it("rejects undeclared collections before touching D1", async () => {
		const { DB } = makeDatabase(1);
		expect(() => assertStorageCollectionDeclared("secret", ["items"])).toThrow(
			"Storage collection not declared: secret",
		);
		expect(DB.prepare).not.toHaveBeenCalled();
	});
});
