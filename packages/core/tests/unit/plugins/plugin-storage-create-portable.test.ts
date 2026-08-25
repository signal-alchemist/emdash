import { describe, expect, it, vi } from "vitest";
import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";

function databaseWith(result: unknown) {
	const conflict: {
		columns: ReturnType<typeof vi.fn>;
		doNothing: ReturnType<typeof vi.fn>;
	} = { columns: vi.fn(), doNothing: vi.fn() };
	conflict.columns.mockReturnValue(conflict);
	conflict.doNothing.mockReturnValue(conflict);
	const builder = {
		values: vi.fn(() => builder),
		onConflict: vi.fn((callback: (value: typeof conflict) => unknown) => {
			callback(conflict);
			return builder;
		}),
		executeTakeFirst: vi.fn(async () => result),
	};
	return { db: { insertInto: vi.fn(() => builder) }, builder, conflict };
}

describe("PluginStorageRepository.create portable builder contract", () => {
	it.each([
		[1, true],
		[1n, true],
		[0, false],
		[undefined, false],
	])("maps affected rows %s to %s without a native database", async (affected, expected) => {
		const { db, builder, conflict } = databaseWith({ numInsertedOrUpdatedRows: affected });
		const repository = new PluginStorageRepository(db as never, "plugin", "items", []);
		expect(await repository.create("id", { value: 1 })).toBe(expected);
		expect(db.insertInto).toHaveBeenCalledWith("_plugin_storage");
		expect(builder.onConflict).toHaveBeenCalled();
		expect(conflict.columns).toHaveBeenCalledWith(["plugin_id", "collection", "id"]);
		expect(conflict.doNothing).toHaveBeenCalled();
	});
});
