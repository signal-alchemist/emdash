import { describe, expect, it } from "vitest";

import { buildMediaManifest, serializeMediaManifest, validateMediaSourceRef } from "../src/media-manifest.js";
import type { MediaSourceRef } from "../src/index.js";

const sha = "a".repeat(64);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const media: MediaSourceRef = {
	sourcePath: "assets/hero.png",
	sha256: sha,
	mimeType: "image/png",
	bytes: png.byteLength,
	width: 1,
	height: 1,
	alt: "Hero image",
};

describe("media manifest", () => {
	it("validates MIME metadata separately from magic bytes", () => {
		expect(validateMediaSourceRef(media, png)).toEqual(media);
		expect(() => validateMediaSourceRef({ ...media, sha256: sha.toUpperCase() }, png)).toThrow("media.sha256_invalid");
		expect(() => validateMediaSourceRef({ ...media, sha256: "abc" }, png)).toThrow("media.sha256_invalid");
		expect(() => validateMediaSourceRef({ ...media, mimeType: "image/jpeg" }, png)).toThrow("media.mime_invalid");
		expect(() => validateMediaSourceRef({ ...media, sourcePath: "assets/hero.svg", mimeType: "image/svg+xml" }, png)).toThrow("media.source_path_invalid");
		expect(() => validateMediaSourceRef({ ...media, sourcePath: "assets/hero.jpg", mimeType: "image/jpeg" }, png)).toThrow("media.magic_mismatch");
		expect(() => validateMediaSourceRef({ ...media, bytes: png.byteLength - 1 }, png)).toThrow("media.bytes_mismatch");
		expect(() => validateMediaSourceRef({ ...media, bytes: 5 * 1024 * 1024 + 1 })).toThrow("media.bytes_invalid");
	});

	it("rejects unsafe paths, dimensions, and alt text", () => {
		for (const sourcePath of ["", "../hero.png", "assets//hero.png", "assets\\hero.png", "/tmp/hero.png", "assets/hero.txt", "assets/hero.png?x=1", "assets/hero.png#fragment", "assets/./hero.png", "assets/a..png", `assets/${String.fromCharCode(0)}hero.png`]) {
			expect(() => validateMediaSourceRef({ ...media, sourcePath }, png)).toThrow("media.source_path_invalid");
		}
		const { width: _width, height: _height, ...withoutDimensions } = media;
		for (const dimensions of [{ width: 1 }, { height: 1 }, { width: 0, height: 1 }, { width: 1.5, height: 1 }, { width: 10_001, height: 1 }]) {
			expect(() => validateMediaSourceRef({ ...withoutDimensions, ...dimensions })).toThrow(/media\.(dimensions_pair|width|height)_invalid/);
		}
		expect(() => validateMediaSourceRef({ ...media, width: 10_000, height: 10_000 })).toThrow("media.pixel_count_invalid");
		expect(() => validateMediaSourceRef({ ...media, alt: "" }, png)).toThrow("media.alt_invalid");
		expect(() => validateMediaSourceRef({ ...media, alt: 42 }, png)).toThrow("media.alt_invalid");
		expect(() => validateMediaSourceRef({ ...media, alt: "x".repeat(513) }, png)).toThrow("media.alt_invalid");
		expect(() => validateMediaSourceRef({ ...media, alt: `safe${String.fromCharCode(10)}alt` }, png)).toThrow("media.alt_invalid");
	});

	it("rejects unknown keys and custom prototypes", () => {
		expect(() => validateMediaSourceRef({ ...media, unknown: true }, png)).toThrow("media.invalid");
		const custom = Object.create({ inherited: true });
		Object.assign(custom, media);
		expect(() => validateMediaSourceRef(custom, png)).toThrow("media.invalid");
	});

	it("collapses exact duplicates, rejects conflicting duplicates, and preserves metadata", () => {
		const withMetadata = { ...media, emdashMediaId: "media-1" };
		const contentMap = new Map([[withMetadata.sourcePath, png]]);
		const originalBytes = [...png];
		const manifest = buildMediaManifest([withMetadata, { ...withMetadata }], contentMap);
		expect(manifest.media).toEqual([withMetadata]);
		expect([...contentMap.get(withMetadata.sourcePath)!]).toEqual(originalBytes);
		expect(() => buildMediaManifest([media, { ...media, alt: "Different" }], new Map([[media.sourcePath, png]]))).toThrow("media.duplicate_conflict");
		expect(() => buildMediaManifest([media, { ...media, sourcePath: "assets/other.png" }], new Map([[media.sourcePath, png], ["assets/other.png", png]]))).toThrow("media.duplicate_conflict");
		expect(() => buildMediaManifest([media, { ...media, sha256: "b".repeat(64) }], new Map([[media.sourcePath, png]]))).toThrow("media.duplicate_conflict");
		expect(() => buildMediaManifest([media], new Map())).toThrow("media.content_missing");
	});

	it("sorts and serializes byte-stably without mutating input", () => {
		const other = { ...media, sourcePath: "assets/other.png", sha256: "b".repeat(64), alt: "Other" };
		const entries = [other, media];
		const output = serializeMediaManifest(entries, new Map([[media.sourcePath, png], [other.sourcePath, png]]));
		expect(output).toBe(serializeMediaManifest(entries.toReversed(), new Map([[media.sourcePath, png], [other.sourcePath, png]])));
		expect(entries).toEqual([other, media]);
		expect(JSON.parse(output).media.map((entry: MediaSourceRef) => entry.sourcePath)).toEqual([media.sourcePath, other.sourcePath]);
		const oversized: MediaSourceRef[] = [];
		for (let index = 0; index < 10_001; index += 1) oversized.push({ ...media });
		expect(() => buildMediaManifest(oversized)).toThrow("media.entries_limit");
	});
});
