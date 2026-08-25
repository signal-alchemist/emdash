import { describe, expect, it, vi } from "vitest";

import { createBridgeHandler, mediaUpload } from "../src/sandbox/bridge-handler.js";

const bytes = [1, 2, 3, 4];
const digest = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const options = { sha256: digest, alt: "A", deduplicate: true };

function dbFor({
	existing,
	winner,
	insertError,
}: { existing?: unknown; winner?: unknown; insertError?: Error } = {}) {
	const selections = [existing, winner];
	const select = vi.fn().mockImplementation(() => ({
		where() {
			return this;
		},
		selectAll() {
			return this;
		},
		executeTakeFirst: vi.fn(async () => selections.shift()),
	}));
	const insert = vi.fn().mockReturnValue({
		values() {
			return this;
		},
		execute: vi.fn(async () => {
			if (insertError) throw insertError;
		}),
	});
	return { selectFrom: select, insertInto: insert } as never;
}
const storage = () => ({
	upload: vi.fn(async () => undefined),
	delete: vi.fn(async () => undefined),
});

describe("workerd media bridge upload contract", () => {
	it("rejects digest mismatch before storage", async () => {
		const s = storage();
		await expect(
			mediaUpload(
				dbFor(),
				"x.pdf",
				"application/pdf",
				bytes,
				undefined,
				{ ...options, sha256: "0".repeat(64) },
				s,
			),
		).rejects.toThrow(/does not match/);
		expect(s.upload).not.toHaveBeenCalled();
	});
	it("accepts Unicode alt text and rejects controls through the bridge", async () => {
		const winner = {
			id: "unicode",
			storage_key: "unicode.pdf",
			mime_type: "application/pdf",
			size: 4,
			width: 1,
			height: 1,
			alt: "画像 🚀",
		};
		await expect(
			mediaUpload(
				dbFor({ existing: winner }),
				"x.pdf",
				"application/pdf",
				bytes,
				undefined,
				{ ...options, alt: "画像 🚀" },
				storage(),
			),
		).resolves.toMatchObject({ mediaId: "unicode" });
		for (const alt of ["bad\u0000", "bad\u001f", "bad\u007f"]) {
			await expect(
				mediaUpload(
					dbFor(),
					"x.pdf",
					"application/pdf",
					bytes,
					undefined,
					{ ...options, alt },
					storage(),
				),
			).rejects.toThrow(/alt/);
		}
	});
	it("replays exact records and rejects metadata conflicts", async () => {
		const winner = {
			id: "m1",
			storage_key: "m1.pdf",
			mime_type: "application/pdf",
			size: 4,
			width: 1,
			height: 1,
			alt: "A",
		};
		const s = storage();
		await expect(
			mediaUpload(
				dbFor({ existing: winner }),
				"x.pdf",
				"application/pdf",
				bytes,
				undefined,
				options,
				s,
			),
		).resolves.toMatchObject({ mediaId: "m1" });
		await expect(
			mediaUpload(
				dbFor({ existing: { ...winner, alt: "B" } }),
				"x.pdf",
				"application/pdf",
				bytes,
				undefined,
				options,
				s,
			),
		).rejects.toThrow(/metadata conflicts/);
	});
	it("cleans the loser and returns the concurrent winner", async () => {
		const s = storage();
		const result = await mediaUpload(
			dbFor({
				winner: {
					id: "winner",
					storage_key: "winner.pdf",
					mime_type: "application/pdf",
					size: 4,
					width: 9,
					height: 9,
					alt: "A",
				},
				insertError: new Error("unique"),
			}),
			"x.pdf",
			"application/pdf",
			bytes,
			undefined,
			options,
			s,
		);
		expect(result.mediaId).toBe("winner");
		expect(s.upload).toHaveBeenCalledOnce();
		expect(s.delete).toHaveBeenCalledOnce();
	});
	it("enforces write capability through the handler", async () => {
		const handler = createBridgeHandler({
			db: dbFor(),
			pluginId: "p",
			version: "1",
			capabilities: [],
			allowedHosts: [],
			storageCollections: [],
			emailSend: () => null,
		} as never);
		const response = await handler(
			new Request("https://bridge/media/upload", {
				method: "POST",
				body: JSON.stringify({ filename: "x.pdf", contentType: "application/pdf", bytes }),
			}),
		);
		expect(await response.text()).toContain("Missing capability: write:media");
	});
	it("rejects unknown and malformed options before storage or DB", async () => {
		const s = storage();
		const handler = createBridgeHandler({
			db: dbFor(),
			pluginId: "p",
			version: "1",
			capabilities: ["write:media"],
			allowedHosts: [],
			storageCollections: [],
			storage: s,
			emailSend: () => null,
		} as never);
		for (const invalidOptions of [{ extra: true }, { sha256: 1 }, { alt: 1 }, { deduplicate: "yes" }]) {
			const response = await handler(
				new Request("https://bridge/media/upload", {
					method: "POST",
					body: JSON.stringify({
						filename: "x.pdf",
						contentType: "application/pdf",
						bytes,
					options: invalidOptions,
					}),
				}),
			);
			expect(response.status).toBe(500);
		}
		expect(s.upload).not.toHaveBeenCalled();
	});
});
