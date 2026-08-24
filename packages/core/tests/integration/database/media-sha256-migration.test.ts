import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration from "../../../src/database/migrations/071_media_sha256.js";
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

		const row = await sql<{
			sha256: string | null;
		}>`SELECT sha256 FROM media WHERE id = 'legacy-null'`.executeTakeFirstOrThrow(ctx.db);
		const hashed = await sql<{
			sha256: string | null;
		}>`SELECT sha256 FROM media WHERE id = 'hashed'`.executeTakeFirstOrThrow(ctx.db);
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
		const restored = await sql<{
			sha256: string | null;
		}>`SELECT sha256 FROM media WHERE id = 'legacy-null'`.executeTakeFirstOrThrow(ctx.db);
		expect(restored.sha256).toBeNull();
	});
});
