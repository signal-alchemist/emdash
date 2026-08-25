import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "media", "sha256"))) {
		await db.schema.alterTable("media").addColumn("sha256", "text").execute();
	}
	await db.schema
		.createIndex("idx_media_sha256")
		.ifNotExists()
		.unique()
		.on("media")
		.column("sha256")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_media_sha256").ifExists().execute();
	if (await columnExists(db, "media", "sha256")) {
		await db.schema.alterTable("media").dropColumn("sha256").execute();
	}
}
