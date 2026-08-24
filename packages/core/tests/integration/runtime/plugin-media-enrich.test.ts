import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { createMediaAccessWithWrite } from "../../../src/plugins/context.js";
import type { Storage } from "../../../src/storage/types.js";
import { JPEG_4x4 } from "../../utils/image-fixtures.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function fakeStorage(): { storage: Storage; store: Map<string, Uint8Array> } {
	const store = new Map<string, Uint8Array>();
	const storage: Storage = {
		async upload(o) {
			const b = o.body instanceof Uint8Array ? o.body : new Uint8Array(o.body as ArrayBuffer);
			store.set(o.key, b);
			return { key: o.key, url: `/m/${o.key}`, size: b.byteLength };
		},
		async download(key) {
			const b = store.get(key) ?? new Uint8Array();
			return {
				body: new Response(b).body as ReadableStream<Uint8Array>,
				contentType: "application/octet-stream",
				size: b.byteLength,
			};
		},
		async delete(key) {
			store.delete(key);
		},
		async exists(key) {
			return store.has(key);
		},
		async list() {
			return { files: [] };
		},
		async getSignedUploadUrl(o) {
			return {
				url: `/s/${o.key}`,
				method: "PUT",
				headers: {},
				expiresAt: new Date().toISOString(),
			};
		},
		getPublicUrl(key) {
			return `/m/${key}`;
		},
	};
	return { storage, store };
}

describe("plugin ctx.media.upload — metadata enrichment", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("populates width, height, blurhash and dominantColor for an image upload", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage().storage);
		const ab = JPEG_4x4.slice().buffer; // clean ArrayBuffer copy
		const result = await media.upload("derived.jpg", "image/jpeg", ab);

		const row = await new MediaRepository(db).findById(result.mediaId);
		expect(row?.width).toBe(4);
		expect(row?.height).toBe(4);
		expect(row?.blurhash).toBeTruthy();
		expect(row?.dominantColor).toMatch(/^rgb\(/);
		expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await new MediaRepository(db).findBySha256(row!.sha256!.toUpperCase())).toMatchObject({
			id: row?.id,
		});
	});

	it("leaves metadata null for a non-image upload without throwing", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage().storage);
		const result = await media.upload(
			"data.bin",
			"application/octet-stream",
			new Uint8Array([1, 2, 3, 4]).buffer,
		);

		const row = await new MediaRepository(db).findById(result.mediaId);
		expect(row?.width).toBeNull();
		expect(row?.blurhash).toBeNull();
		expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("reuses an exact SHA-256 media replay and rejects metadata conflicts", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage().storage);
		const bytes = JPEG_4x4.slice().buffer;
		const first = await media.upload("replay.jpg", "image/jpeg", bytes, {
			deduplicate: true,
			alt: "A replay",
		});
		const second = await media.upload("replay-again.jpg", "image/jpeg", bytes, {
			deduplicate: true,
			alt: "A replay",
		});
		expect(second.mediaId).toBe(first.mediaId);
		await expect(
			media.upload("replay.jpg", "image/jpeg", bytes, {
				deduplicate: true,
				alt: "Different alt",
			}),
		).rejects.toThrow(/metadata conflicts/i);
		await expect(media.findBySha256!("bad")).rejects.toThrow(/sha-256/i);
		await expect(
			media.upload("replay.jpg", "image/jpeg", bytes, { deduplicate: true, alt: "\n" }),
		).rejects.toThrow(/alt/i);
	});

	it("reconciles ordinary identical replays despite the unique SHA index", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage().storage);
		const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
		const first = await media.upload("plain.bin", "application/octet-stream", bytes);
		const second = await media.upload("plain-again.bin", "application/octet-stream", bytes);
		expect(second.mediaId).toBe(first.mediaId);
	});

	it("reconciles concurrent identical uploads and cleans the losing storage key", async () => {
		const backend = fakeStorage();
		const media = createMediaAccessWithWrite(db, undefined, backend.storage);
		const bytes = new Uint8Array([5, 6, 7, 8]).buffer;
		const results = await Promise.all([
			media.upload("race-a.bin", "application/octet-stream", bytes),
			media.upload("race-b.bin", "application/octet-stream", bytes),
		]);

		expect(results[0].mediaId).toBe(results[1].mediaId);
		expect(backend.store.size).toBe(1);
	});
});
