import type { ContentId, ContentSyncCommand, GitSourceRef } from "./index.js";

export interface ContentIdentityEntry {
	contentId: ContentId;
	locale: string;
	source: GitSourceRef;
	kind: "post" | "page";
	revision: number;
	canonicalRoute: string;
}

export interface ContentIdentityManifest {
	schemaVersion: 1;
	siteId: string;
	entries: ContentIdentityEntry[];
}

export interface ContentIdentityDocument {
	source: Pick<GitSourceRef, "path">;
	locale: string;
	kind: "post" | "page";
	contentId: unknown;
	canonical: unknown;
}

export interface ContentCatalogEntry {
	contentId: ContentId;
	locale: string;
	revision: number;
	route: string;
	type: "post" | "page";
	title: string;
	publishState: "draft" | "published" | "scheduled";
	updatedAt: string;
}

export interface ContentCatalog {
	schemaVersion: 1;
	siteId: string;
	scope: "public" | "internal-draft";
	entries: ContentCatalogEntry[];
}

export type ContentSyncSource = ContentSyncCommand["source"];

const CONTENT_ID = /^content-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ROUTE = /^\/(?:[^/?#\\]+\/)*$/;
const MAX_ENTRIES = 10_000;
const MAX_DOCUMENTS = 10_000;
const MAX_ERRORS = 100;
const MAX_SITE_ID = 128;
const MAX_PATH = 512;
const MAX_ROUTE = 512;
const MAX_BRANCH = 256;
const MAX_REPOSITORY = 200;
const MAX_DELIVERY_ID = 256;
const MAX_LOCALE = 32;
const MAX_TITLE = 500;
const MAX_CONTENT_ROOTS = 32;
const MAX_CONTENT_ROOT = 128;

const MANIFEST_KEYS = new Set(["schemaVersion", "siteId", "entries"]);
const ENTRY_KEYS = new Set(["contentId", "locale", "source", "kind", "revision", "canonicalRoute"]);
const SOURCE_KEYS = new Set(["repository", "branch", "path", "commitSha", "deliveryId"]);
const DOCUMENT_KEYS = new Set(["source", "locale", "kind", "contentId", "canonical"]);
const CATALOG_KEYS = new Set(["schemaVersion", "siteId", "scope", "entries"]);
const CATALOG_ENTRY_KEYS = new Set([
	"contentId",
	"locale",
	"revision",
	"route",
	"type",
	"title",
	"publishState",
	"updatedAt",
]);
// eslint-disable-next-line no-control-regex -- reject control and NUL bytes in untrusted identity fields.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const WHITESPACE = /\s/u;
const CONTENT_EXTENSION = /\.(?:md|mdx)$/u;
const ENTRY_SOURCE_KEYS = new Set(["path"]);
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function addError(errors: string[], code: string, maxErrors: number): boolean {
	if (errors.length >= maxErrors) return false;
	errors.push(code);
	return errors.length < maxErrors;
}

function validText(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTERS.test(value);
}

function validLocale(value: unknown): value is string {
	return validText(value, MAX_LOCALE) && value === value.toLowerCase() && LOCALE.test(value);
}

function validPath(value: unknown, roots: readonly string[]): value is string {
	if (!validText(value, MAX_PATH) || value.includes("\\") || value.startsWith("/") || value.includes("//")) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") && CONTENT_EXTENSION.test(value) && roots.some((root) => value.startsWith(root));
}

function validRoute(value: unknown): value is string {
	return validText(value, MAX_ROUTE) && ROUTE.test(value) && !value.includes("//") && !value.split("/").some((segment) => segment === "." || segment === "..");
}

function validSource(value: unknown, roots: readonly string[]): value is ContentSyncSource {
	if (!isPlainRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) return false;
	if (!validText(value.repository, MAX_REPOSITORY) || !REPOSITORY.test(value.repository)) return false;
	if (!validText(value.branch, MAX_BRANCH) || !BRANCH.test(value.branch) || value.branch.includes("..") || value.branch.includes("//") || value.branch.endsWith("/")) return false;
	if (!validPath(value.path, roots) || !validText(value.commitSha, 40) || !COMMIT_SHA.test(value.commitSha)) return false;
	return value.deliveryId === undefined || (validText(value.deliveryId, MAX_DELIVERY_ID) && !WHITESPACE.test(value.deliveryId));
}

function validSiteId(value: unknown): value is string {
	return validText(value, MAX_SITE_ID) && SITE_ID.test(value);
}

function normalizedRoots(roots: readonly string[] | undefined): string[] | undefined {
	const selected = roots && roots.length > 0 ? roots : ["src/content/"];
	if (selected.length > MAX_CONTENT_ROOTS) return undefined;
	if (selected.some((root) => typeof root !== "string" || root.length > MAX_CONTENT_ROOT)) return undefined;
	const normalized = selected.filter((root) => typeof root === "string" && root.length > 0 && root.endsWith("/") && validPath(`${root}entry.md`, [root]));
	return normalized.length === selected.length ? normalized : undefined;
}

function sourceForEntry(entries: readonly unknown[], index: number): Record<string, unknown> | undefined {
	const value = entries[index];
	return isPlainRecord(value) ? value : undefined;
}

export function validateContentIdentityManifest(
	input: unknown,
	documents: readonly ContentIdentityDocument[],
	expectedSiteId: string,
	options: { maxErrors?: number; contentRoots?: readonly string[] } = {},
): string[] {
	const maxErrors = Math.min(MAX_ERRORS, Math.max(1, Math.floor(options.maxErrors ?? MAX_ERRORS)));
	const roots = normalizedRoots(options.contentRoots);
	const errors: string[] = [];
	if (!roots) return ["content_roots.invalid"];
	if (!isPlainRecord(input) || !hasExactKeys(input, MANIFEST_KEYS) || input.schemaVersion !== 1 || !validSiteId(input.siteId) || !Array.isArray(input.entries)) return ["manifest.invalid"];
	if (input.siteId !== expectedSiteId && !addError(errors, "manifest.site_id_mismatch", maxErrors)) return errors;
	if (input.entries.length > MAX_ENTRIES) {
		addError(errors, "manifest.entries_limit", maxErrors);
		return errors;
	}
	if (documents.length > MAX_DOCUMENTS) {
		addError(errors, "documents.limit", maxErrors);
		return errors;
	}

	const contentIds = new Map<string, number>();
	const sourcePaths = new Map<string, number>();
	for (const [index, value] of input.entries.entries()) {
		if (errors.length >= maxErrors) return errors;
		const prefix = `entries[${index}]`;
		if (!isPlainRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) {
			if (!addError(errors, `${prefix}.invalid`, maxErrors)) return errors;
			continue;
		}
		const entry = value;
		if (!validText(entry.contentId, 128) || !CONTENT_ID.test(entry.contentId)) addError(errors, `${prefix}.content_id_invalid`, maxErrors);
		if (!validLocale(entry.locale)) addError(errors, `${prefix}.locale_invalid`, maxErrors);
		if (!validSource(entry.source, roots)) addError(errors, `${prefix}.source_invalid`, maxErrors);
		if (entry.kind !== "post" && entry.kind !== "page") addError(errors, `${prefix}.kind_invalid`, maxErrors);
		if (typeof entry.revision !== "number" || !Number.isSafeInteger(entry.revision) || entry.revision < 1) addError(errors, `${prefix}.revision_invalid`, maxErrors);
		if (!validRoute(entry.canonicalRoute)) addError(errors, `${prefix}.route_invalid`, maxErrors);
		if (typeof entry.contentId === "string") {
			if (contentIds.has(entry.contentId)) addError(errors, `${prefix}.content_id_duplicate`, maxErrors);
			contentIds.set(entry.contentId, index);
		}
		if (isPlainRecord(entry.source) && typeof entry.source.path === "string") {
			if (sourcePaths.has(entry.source.path)) addError(errors, `${prefix}.source_path_duplicate`, maxErrors);
			sourcePaths.set(entry.source.path, index);
		}
	}

	const documentIds = new Map<string, number>();
	const documentPaths = new Map<string, number>();
	const documentsByPath = new Map<string, ContentIdentityDocument>();
	for (const [index, document] of documents.entries()) {
		if (errors.length >= maxErrors) return errors;
		const prefix = `documents[${index}]`;
		if (!isPlainRecord(document) || !hasExactKeys(document, DOCUMENT_KEYS) || !isPlainRecord(document.source) || !hasExactKeys(document.source, ENTRY_SOURCE_KEYS)) {
			if (!addError(errors, `${prefix}.invalid`, maxErrors)) return errors;
			continue;
		}
		const pathIsValid = validPath(document.source.path, roots);
		if (!pathIsValid) addError(errors, `${prefix}.source_path_invalid`, maxErrors);
		if (!validLocale(document.locale)) addError(errors, `${prefix}.locale_invalid`, maxErrors);
		if (document.kind !== "post" && document.kind !== "page") addError(errors, `${prefix}.kind_invalid`, maxErrors);
		if (typeof document.contentId !== "string" || !CONTENT_ID.test(document.contentId)) addError(errors, `${prefix}.content_id_invalid`, maxErrors);
		if (!validRoute(document.canonical)) addError(errors, `${prefix}.route_invalid`, maxErrors);
		if (typeof document.source.path === "string") {
			if (documentPaths.has(document.source.path)) addError(errors, `${prefix}.source_path_duplicate`, maxErrors);
			documentPaths.set(document.source.path, index);
			if (pathIsValid) documentsByPath.set(document.source.path, document);
		}
		if (typeof document.contentId === "string") {
			if (documentIds.has(document.contentId)) addError(errors, `${prefix}.content_id_duplicate`, maxErrors);
			documentIds.set(document.contentId, index);
		}
	}

	for (const [path, index] of sourcePaths) {
		if (errors.length >= maxErrors) return errors;
		const entry = sourceForEntry(input.entries, index);
		const document = documentsByPath.get(path);
		if (!document) {
			addError(errors, `entries[${index}].document_missing`, maxErrors);
			continue;
		}
		if (!entry || document.locale !== entry.locale) addError(errors, `entries[${index}].locale_mismatch`, maxErrors);
		if (!entry || document.kind !== entry.kind) addError(errors, `entries[${index}].kind_mismatch`, maxErrors);
		if (!entry || document.contentId !== entry.contentId) addError(errors, `entries[${index}].content_id_mismatch`, maxErrors);
		if (!entry || document.canonical !== entry.canonicalRoute) addError(errors, `entries[${index}].route_mismatch`, maxErrors);
	}
	for (const [path, index] of documentPaths) {
		if (errors.length >= maxErrors) return errors;
		if (!sourcePaths.has(path)) addError(errors, `documents[${index}].manifest_missing`, maxErrors);
	}
	return errors;
}

function validateCatalog(catalog: unknown): asserts catalog is ContentCatalog {
	if (!isPlainRecord(catalog) || !hasExactKeys(catalog, CATALOG_KEYS) || catalog.schemaVersion !== 1 || !validSiteId(catalog.siteId) || (catalog.scope !== "public" && catalog.scope !== "internal-draft") || !Array.isArray(catalog.entries) || catalog.entries.length > MAX_ENTRIES) throw new Error("catalog.invalid");
	const identities = new Set<string>();
	const routes = new Set<string>();
	for (const [index, value] of catalog.entries.entries()) {
		if (!isPlainRecord(value) || !hasExactKeys(value, CATALOG_ENTRY_KEYS) || !validText(value.contentId, 128) || !CONTENT_ID.test(value.contentId) || !validLocale(value.locale) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 || !validRoute(value.route) || (value.type !== "post" && value.type !== "page") || !validText(value.title, MAX_TITLE) || (value.publishState !== "draft" && value.publishState !== "published" && value.publishState !== "scheduled") || !validText(value.updatedAt, 32) || Number.isNaN(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt) throw new Error(`catalog.entries[${index}].invalid`);
		if (catalog.scope === "public" && value.publishState !== "published") throw new Error(`catalog.entries[${index}].public_state_invalid`);
		const identity = `${value.contentId}:${value.locale}`;
		if (identities.has(identity)) throw new Error(`catalog.entries[${index}].identity_duplicate`);
		identities.add(identity);
		if (routes.has(value.route)) throw new Error(`catalog.entries[${index}].route_duplicate`);
		routes.add(value.route);
	}
}

export function serializeContentCatalog(catalog: ContentCatalog): string {
	validateCatalog(catalog);
	const entries = [...catalog.entries];
	// oxlint-disable-next-line unicorn(no-array-sort), e18e(prefer-array-to-sorted) -- ES2022 package target does not provide toSorted.
	entries.sort((left, right) => `${left.contentId}:${left.locale}`.localeCompare(`${right.contentId}:${right.locale}`, "en"));
	return `${JSON.stringify({ schemaVersion: 1, siteId: catalog.siteId, scope: catalog.scope, entries })}\n`;
}
