import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration from "../../../src/database/migrations/071_media_sha256.js";
import { MIGRATION_NAMES } from "../../../src/database/migrations/runner.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media SHA-256 migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("supports nullable legacy rows and indexed SHA-256 values across dialects", async () => {
		await sql`INSERT INTO media (id, filename, mime_type, storage_key, status, sha256)
			VALUES ('legacy-null', 'legacy.bin', 'application/octet-stream', 'legacy.bin', 'ready', NULL)`.execute(
			ctx.db,
		);
		await sql`INSERT INTO media (id, filename, mime_type, storage_key, status, sha256)
			VALUES ('hashed', 'hashed.bin', 'application/octet-stream', 'hashed.bin', 'ready', ${"a".repeat(64)})`.execute(
			ctx.db,
		);

		const row = (
			await ctx.db.executeQuery(
				sql<{ sha256: string | null }>`SELECT sha256 FROM media WHERE id = 'legacy-null'`.compile(
					ctx.db,
				),
			)
		).rows[0];
		const hashed = (
			await ctx.db.executeQuery(
				sql<{ sha256: string | null }>`SELECT sha256 FROM media WHERE id = 'hashed'`.compile(
					ctx.db,
				),
			)
		).rows[0];
		expect(row.sha256).toBeNull();
		expect(hashed.sha256).toBe("a".repeat(64));
		await expect(
			sql`INSERT INTO media (id, filename, mime_type, storage_key, status, sha256)
				VALUES ('duplicate-hash', 'duplicate.bin', 'application/octet-stream', 'duplicate.bin', 'ready', ${"a".repeat(64)})`.execute(
				ctx.db,
			),
		).rejects.toThrow();

		await migration.down(ctx.db);
		await migration.up(ctx.db);
		const restored = (
			await ctx.db.executeQuery(
				sql<{ sha256: string | null }>`SELECT sha256 FROM media WHERE id = 'legacy-null'`.compile(
					ctx.db,
				),
			)
		).rows[0];
		expect(restored.sha256).toBeNull();
	});

	it("keeps migration registration ordered and uses the compiled raw-query API", async () => {
		expect(MIGRATION_NAMES.at(-1)).toBe("071_media_sha256");
		expect(MIGRATION_NAMES.indexOf("070_collection_routable")).toBeLessThan(
			MIGRATION_NAMES.indexOf("071_media_sha256"),
		);
		if (ctx.dialect === "sqlite") {
			const result = await ctx.db.executeQuery(
				sql<{
					name: string;
				}>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media'`.compile(ctx.db),
			);
			expect(result.rows[0]?.name).toBe("media");
		} else {
			const result = await ctx.db.executeQuery(
				sql<{
					table_name: string;
				}>`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'media'`.compile(
					ctx.db,
				),
			);
			expect(result.rows[0]?.table_name).toBe("media");
		}
	});
});
