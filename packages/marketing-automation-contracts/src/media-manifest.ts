import type { MediaSourceRef } from "./index.js";

export interface MediaManifest {
	schemaVersion: 1;
	media: MediaSourceRef[];
}

const SHA256 = /^[0-9a-f]{64}$/u;
const MEDIA_ID = /^media-[a-z0-9][a-z0-9_-]{0,127}$/u;
const MAX_SOURCE_PATH = 512;
const MAX_FILENAME = 128;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 10_000;
const MAX_PIXELS = 40_000_000;
const MAX_ALT = 512;
const MAX_MEDIA_ENTRIES = 10_000;

const MIME_BY_EXTENSION = new Map([
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["png", "image/png"],
	["gif", "image/gif"],
	["webp", "image/webp"],
	["avif", "image/avif"],
]);
const MEDIA_KEYS = new Set(["sourcePath", "sha256", "mimeType", "bytes", "width", "height", "alt", "emdashMediaId"]);

function invalid(code: string): never {
	throw new Error(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasOnlyKnownKeys(value: Record<string, unknown>): boolean {
	return Object.keys(value).every((key) => MEDIA_KEYS.has(key));
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

function validSourcePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE_PATH || hasControlCharacters(value)) return false;
	if (value.includes("\\") || value.startsWith("/") || value.includes("//")) return false;
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
	const filename = segments.at(-1) ?? "";
	const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
	return filename.length <= MAX_FILENAME && filename.split(".").length === 2 && MIME_BY_EXTENSION.has(extension);
}

function magicMatches(bytes: Uint8Array, mimeType: string): boolean {
	if (mimeType === "image/png") return bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]);
	if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mimeType === "image/gif") return bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).startsWith("GIF");
	if (mimeType === "image/webp") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
	if (mimeType === "image/avif") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp" && ["avif", "avis"].includes(new TextDecoder().decode(bytes.slice(8, 12)));
	return false;
}

export function validateMediaSourceRef(input: unknown, bytes?: Uint8Array): MediaSourceRef {
	if (!isPlainRecord(input) || !hasOnlyKnownKeys(input)) invalid("media.invalid");
	if (!validSourcePath(input.sourcePath)) invalid("media.source_path_invalid");
	if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) invalid("media.sha256_invalid");
	const extension = input.sourcePath.split(".").at(-1)?.toLowerCase() ?? "";
	const mimeType = MIME_BY_EXTENSION.get(extension);
	if (typeof input.mimeType !== "string" || mimeType !== input.mimeType.toLowerCase()) invalid("media.mime_invalid");
	const byteCount = input.bytes;
	if (typeof byteCount !== "number" || !Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > MAX_BYTES) invalid("media.bytes_invalid");
	if (bytes && bytes.byteLength !== byteCount) invalid("media.bytes_mismatch");
	if (bytes && !magicMatches(bytes, mimeType)) invalid("media.magic_mismatch");
	const width = input.width;
	const height = input.height;
	const normalizedWidth = typeof width === "number" ? width : undefined;
	const normalizedHeight = typeof height === "number" ? height : undefined;
	for (const [key, value] of [["width", width], ["height", height]] as const) {
		if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION)) invalid(`media.${key}_invalid`);
	}
	if ((width === undefined) !== (height === undefined)) invalid("media.dimensions_pair_invalid");
	if (normalizedWidth === undefined && width !== undefined || normalizedHeight === undefined && height !== undefined) invalid("media.dimensions_invalid");
	if (normalizedWidth !== undefined && normalizedHeight !== undefined && normalizedWidth * normalizedHeight > MAX_PIXELS) invalid("media.pixel_count_invalid");
	if (typeof input.alt !== "string") invalid("media.alt_invalid");
	const alt = input.alt;
	if (alt.length === 0 || alt.length > MAX_ALT || hasControlCharacters(alt)) invalid("media.alt_invalid");
	if (input.emdashMediaId !== undefined && (typeof input.emdashMediaId !== "string" || !MEDIA_ID.test(input.emdashMediaId))) invalid("media.id_invalid");
	return {
		sourcePath: input.sourcePath,
		sha256: input.sha256,
		mimeType: mimeType,
		bytes: byteCount,
		...(normalizedWidth === undefined ? {} : { width: normalizedWidth }),
		...(normalizedHeight === undefined ? {} : { height: normalizedHeight }),
		alt,
		...(input.emdashMediaId === undefined ? {} : { emdashMediaId: input.emdashMediaId }),
	};
}

function sameEntry(left: MediaSourceRef, right: MediaSourceRef): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function mergeSort(entries: readonly MediaSourceRef[]): MediaSourceRef[] {
	if (entries.length < 2) return [...entries];
	const middle = Math.floor(entries.length / 2);
	const left = mergeSort(entries.slice(0, middle));
	const right = mergeSort(entries.slice(middle));
	const merged: MediaSourceRef[] = [];
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length || rightIndex < right.length) {
		const leftEntry = left[leftIndex];
		const rightEntry = right[rightIndex];
		if (rightEntry === undefined || (leftEntry !== undefined && leftEntry.sourcePath.localeCompare(rightEntry.sourcePath, "en") <= 0)) {
			if (leftEntry) merged.push(leftEntry);
			leftIndex += 1;
		} else {
			merged.push(rightEntry);
			rightIndex += 1;
		}
	}
	return merged;
}

export function buildMediaManifest(entries: readonly MediaSourceRef[], contents?: ReadonlyMap<string, Uint8Array>): MediaManifest {
	if (entries.length > MAX_MEDIA_ENTRIES) invalid("media.entries_limit");
	const byHash = new Map<string, MediaSourceRef>();
	const byPath = new Map<string, MediaSourceRef>();
	for (const input of entries) {
		let bytes: Uint8Array | undefined;
		if (contents !== undefined) {
			bytes = contents.get(input.sourcePath);
			if (bytes === undefined) invalid("media.content_missing");
		}
		const entry = validateMediaSourceRef(input, bytes);
		const existingHash = byHash.get(entry.sha256);
		const existingPath = byPath.get(entry.sourcePath);
		if ((existingHash && !sameEntry(existingHash, entry)) || (existingPath && !sameEntry(existingPath, entry))) invalid("media.duplicate_conflict");
		byHash.set(entry.sha256, entry);
		byPath.set(entry.sourcePath, entry);
	}
	const media = mergeSort([...byHash.values()]);
	return { schemaVersion: 1, media };
}

export function serializeMediaManifest(entries: readonly MediaSourceRef[], contents?: ReadonlyMap<string, Uint8Array>): string {
	return `${JSON.stringify(buildMediaManifest(entries, contents))}\n`;
}
