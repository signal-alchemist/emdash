import { describe, expect, it, vi } from "vitest";

const TestWorkerEntrypoint = vi.hoisted(() => {
	// oxlint-disable-next-line typescript/no-extraneous-class -- minimal WorkerEntrypoint test double
		return class {
			constructor(ctx: unknown, env: unknown) {
				Object.assign(this, { ctx, env });
			}
		};
});
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: TestWorkerEntrypoint }));
import { PluginBridge } from "../../src/sandbox/bridge.js";

const bytes = new TextEncoder().encode("media").buffer;
const props = {
	pluginId: "p",
	pluginVersion: "1",
	capabilities: ["media:write"],
	allowedHosts: [],
	storageCollections: [],
};

function bridge(db: unknown, media = { put: vi.fn(), delete: vi.fn() }) {
	return { bridge: new PluginBridge({ props } as never, { DB: db, MEDIA: media } as never), media };
}

describe("PluginBridge media upload contract", () => {
	it("fails closed on invalid options and digest before storage mutation", async () => {
		const prepare = vi.fn();
		const { bridge: instance, media } = bridge({ prepare });
		await expect(
			instance.mediaUpload("x.txt", "application/pdf", bytes, { sha256: "bad" }),
		).rejects.toThrow(/64-character/);
		await expect(
			instance.mediaUpload("x.txt", "application/pdf", bytes, { deduplicate: true, alt: "" }),
		).rejects.toThrow(/alt/);
		expect(prepare).not.toHaveBeenCalled();
		expect(media.put).not.toHaveBeenCalled();
	});

	it("accepts Unicode alt text and rejects controls, unknown keys, and malformed types", async () => {
		const digest = await crypto.subtle
			.digest("SHA-256", bytes)
			.then((d) => Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join(""));
		const row = {
			id: "unicode",
			storage_key: "unicode.pdf",
			mime_type: "application/pdf",
			size: 5,
			width: null,
			height: null,
			alt: "画像 🚀",
		};
		const statement = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(row) };
		const { bridge: instance, media } = bridge({ prepare: vi.fn().mockReturnValue(statement) });
		await expect(
			instance.mediaUpload("x.pdf", "application/pdf", bytes, {
				sha256: digest,
				alt: "画像 🚀",
				deduplicate: true,
			}),
		).resolves.toMatchObject({ mediaId: "unicode" });
		for (const alt of ["bad\u0000", "bad\u001f", "bad\u007f"]) {
			await expect(
				instance.mediaUpload("x.pdf", "application/pdf", bytes, {
					deduplicate: true,
					alt,
				} as never),
			).rejects.toThrow(/alt/);
		}
		for (const invalid of [{ extra: true }, { sha256: 1 }, { alt: 1 }, { deduplicate: "yes" }]) {
			await expect(
				instance.mediaUpload("x.pdf", "application/pdf", bytes, invalid as never),
			).rejects.toThrow(/options/);
		}
		expect(media.put).not.toHaveBeenCalled();
	});

	it("requires media write capability", async () => {
		const instance = new PluginBridge(
			{ props: { ...props, capabilities: [] } } as never,
			{ DB: {}, MEDIA: {} } as never,
		);
		await expect(instance.mediaUpload("x.txt", "application/pdf", bytes)).rejects.toThrow(
			"media:write",
		);
	});

	it("reuses an exact ready winner without writing a second object", async () => {
		const row = {
			id: "winner",
			storage_key: "winner.txt",
			mime_type: "application/pdf",
			size: 5,
			width: 640,
			height: 480,
			alt: "A",
		};
		const statement = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(row) };
		const { bridge: instance, media } = bridge({ prepare: vi.fn().mockReturnValue(statement) });
		const result = await instance.mediaUpload("x.txt", "application/pdf", bytes, {
			sha256: await crypto.subtle
				.digest("SHA-256", bytes)
				.then((d) =>
					Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join(""),
				),
			alt: "A",
			deduplicate: true,
		});
		expect(result.mediaId).toBe("winner");
		expect(media.put).not.toHaveBeenCalled();
	});
});
