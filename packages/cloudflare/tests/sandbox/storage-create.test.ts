import { describe, expect, it, vi } from "vitest";
import { storageCreate } from "../../src/sandbox/storage-create.js";

describe("portable Cloudflare D1 storage create", () => {
	it.each([[1, true], [0, false]])("maps D1 changes %s to %s", async (changes, expected) => {
		const statement = {
			bind: vi.fn(function () { return statement; }),
			run: vi.fn(async () => ({ meta: { changes } })),
		};
		const prepare = vi.fn((_sql: string) => statement);
		const db = { prepare };
		expect(await storageCreate(db, "plugin", "items", "one", { ok: true })).toBe(expected);
		expect(prepare.mock.calls[0]?.[0]).toContain("ON CONFLICT(plugin_id, collection, id) DO NOTHING");
	});
});
