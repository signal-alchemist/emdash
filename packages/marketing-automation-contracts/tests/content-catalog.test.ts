import { describe, expect, it } from "vitest";

import { serializeContentCatalog, validateContentIdentityManifest, type ContentCatalog, type ContentIdentityDocument } from "../src/content-catalog.js";
import type { ContentSyncCommand } from "../src/index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const source = { repository: "signal-alchemist/site", branch: "main", path: "src/content/posts/alpha.md", commitSha: sha, deliveryId: "delivery-1" };
const documents: ContentIdentityDocument[] = [{ source: { path: source.path }, locale: "en", kind: "post", contentId: "content-alpha", canonical: "/posts/alpha/" }];
const validManifest = { schemaVersion: 1, siteId: "site-001", entries: [{ contentId: "content-alpha", locale: "en", source, kind: "post", revision: 1, canonicalRoute: "/posts/alpha/" }] };

describe("content identity manifest", () => {
	it("accepts a valid GitSourceRef-compatible identity", () => {
		const syncSource: ContentSyncCommand["source"] = validManifest.entries[0].source;
		expect(syncSource).toEqual(source);
		expect(validateContentIdentityManifest(validManifest, documents, "site-001")).toEqual([]);
	});

	it("detects duplicate IDs and paths in manifests and documents", () => {
		const duplicate = { ...validManifest, entries: [validManifest.entries[0], { ...validManifest.entries[0], contentId: "content-beta" }] };
		const duplicateDocuments = [documents[0], { ...documents[0], contentId: "content-beta" }];
		const errors = validateContentIdentityManifest(duplicate, duplicateDocuments, "site-001");
		expect(errors).toEqual(expect.arrayContaining(["entries[1].source_path_duplicate", "documents[1].source_path_duplicate"]));
	});

	it("reports missing files and document identities", () => {
		const errors = validateContentIdentityManifest(validManifest, [{ ...documents[0], source: { path: "src/content/posts/missing.md" } }], "site-001");
		expect(errors).toEqual(expect.arrayContaining(["entries[0].document_missing", "documents[0].manifest_missing"]));
	});

	it("reports locale, kind, content ID, and route mismatches", () => {
		const errors = validateContentIdentityManifest(validManifest, [{ ...documents[0], locale: "ja", kind: "page", contentId: "content-beta", canonical: "/posts/beta/" }], "site-001");
		expect(errors).toEqual(expect.arrayContaining(["entries[0].locale_mismatch", "entries[0].kind_mismatch", "entries[0].content_id_mismatch", "entries[0].route_mismatch"]));
	});

	it("rejects invalid schema, site, revision, kind, locale, repository, branch, and SHA", () => {
		const entry = { ...validManifest.entries[0], locale: "EN-us", kind: "product", revision: 0, source: { ...source, repository: "bad", branch: "../main", commitSha: "ABC" } };
		const errors = validateContentIdentityManifest({ schemaVersion: 2, siteId: "bad site", entries: [entry] }, documents, "site-001");
		expect(errors).toEqual(["manifest.invalid"]);
		const detailed = validateContentIdentityManifest({ ...validManifest, entries: [entry] }, documents, "site-001");
		expect(detailed).toEqual(expect.arrayContaining(["entries[0].locale_invalid", "entries[0].source_invalid", "entries[0].kind_invalid", "entries[0].revision_invalid"]));
	});

	it("rejects excess fields, custom prototypes, and prototype pollution", () => {
		const excess = { ...validManifest, unexpected: true };
		const polluted = JSON.parse('{"schemaVersion":1,"siteId":"site-001","entries":[],"__proto__":{"polluted":true}}');
		const custom = Object.create({ inherited: true });
		Object.assign(custom, validManifest);
		expect(validateContentIdentityManifest(excess, documents, "site-001")).toEqual(["manifest.invalid"]);
		expect(validateContentIdentityManifest(polluted, [], "site-001")).toEqual(["manifest.invalid"]);
		expect(validateContentIdentityManifest(custom, documents, "site-001")).toEqual(["manifest.invalid"]);
		const nestedExcess = { ...validManifest, entries: [{ ...validManifest.entries[0], source: { ...source, unexpected: true } }] };
		const nestedSource = Object.create({ inherited: true });
		Object.assign(nestedSource, source);
		const nestedCustom = { ...validManifest, entries: [{ ...validManifest.entries[0], source: nestedSource }] };
		const uppercaseSha = { ...validManifest, entries: [{ ...validManifest.entries[0], source: { ...source, commitSha: sha.toUpperCase() } }] };
		expect(validateContentIdentityManifest(nestedExcess, documents, "site-001")).toContain("entries[0].source_invalid");
		expect(validateContentIdentityManifest(nestedCustom, documents, "site-001")).toContain("entries[0].source_invalid");
		expect(validateContentIdentityManifest(uppercaseSha, documents, "site-001")).toContain("entries[0].source_invalid");
	});

	it("rejects path and route edge cases, while accepting configured roots", () => {
		const paths = ["src\\content\\post.md", "src/content//post.md", "src/content/./post.md", "src/content/../post.md", "/tmp/post.md", "src/content/post.txt", `src/content/${"a".repeat(600)}.md`];
		for (const path of paths) {
			const errors = validateContentIdentityManifest({ ...validManifest, entries: [{ ...validManifest.entries[0], source: { ...source, path } }] }, [], "site-001");
			expect(errors).toContain("entries[0].source_invalid");
		}
		const routeErrors = validateContentIdentityManifest({ ...validManifest, entries: [{ ...validManifest.entries[0], canonicalRoute: "//evil/" }] }, documents, "site-001");
		expect(routeErrors).toContain("entries[0].route_invalid");
		const configured = { ...validManifest, entries: [{ ...validManifest.entries[0], source: { ...source, path: "content/posts/alpha.mdx" } }] };
		expect(validateContentIdentityManifest(configured, [{ ...documents[0], source: { path: "content/posts/alpha.mdx" } }], "site-001", { contentRoots: ["content/"] })).toEqual([]);
	});

	it("bounds entries, documents, errors, and attacker-controlled values", () => {
		const longSite = { ...validManifest, siteId: "x".repeat(10_000) };
		expect(validateContentIdentityManifest(longSite, [], "site-001")).toEqual(["manifest.invalid"]);
		const huge = { ...validManifest, entries: Array.from({ length: 10_001 }).fill(validManifest.entries[0]) };
		expect(validateContentIdentityManifest(huge, [], "site-001")).toEqual(["manifest.entries_limit"]);
		const bounded = validateContentIdentityManifest({ ...validManifest, entries: [{ ...validManifest.entries[0], locale: "!" }, { ...validManifest.entries[0], locale: "!" }] }, [], "site-001", { maxErrors: 1 });
		expect(bounded).toEqual(["entries[0].locale_invalid"]);
		expect(validateContentIdentityManifest(validManifest, documents, "site-001", { contentRoots: Array.from({ length: 33 }).fill("src/content/") })).toEqual(["content_roots.invalid"]);
		expect(validateContentIdentityManifest(validManifest, documents, "site-001", { contentRoots: ["src/".repeat(40)] })).toEqual(["content_roots.invalid"]);
	});
});

describe("content catalog serialization", () => {
	const catalog: ContentCatalog = { schemaVersion: 1, siteId: "site-001", scope: "internal-draft", entries: [
		{ contentId: "content-zeta", locale: "en", revision: 2, route: "/posts/zeta/", type: "post", title: "Zeta", publishState: "draft", updatedAt: "2026-08-25T00:00:00.000Z" },
		{ contentId: "content-alpha", locale: "en", revision: 1, route: "/posts/alpha/", type: "post", title: "Alpha", publishState: "published", updatedAt: "2026-08-24T00:00:00.000Z" },
	] };

	it("serializes deterministically without mutating input or exposing body fields", () => {
		const before = JSON.stringify(catalog);
		const output = serializeContentCatalog(catalog);
		const reversed = serializeContentCatalog({ ...catalog, entries: [catalog.entries[1]!, catalog.entries[0]!] });
		expect(output).toBe(reversed);
		expect(JSON.stringify(catalog)).toBe(before);
		expect(Object.keys(JSON.parse(output).entries[0])).not.toContain("body");
		const localeVariants: ContentCatalog = { ...catalog, entries: [
			{ ...catalog.entries[0]!, contentId: "content-alpha", locale: "ja", route: "/posts/alpha-ja/" },
			catalog.entries[1]!,
		] };
		expect(serializeContentCatalog(localeVariants)).toBe(serializeContentCatalog({ ...localeVariants, entries: localeVariants.entries.toReversed() }));
	});

	it("rejects malformed catalogs and non-published public entries", () => {
		expect(() => serializeContentCatalog({ ...catalog, entries: [{ ...catalog.entries[0], locale: "EN" }] })).toThrow("catalog.entries[0].invalid");
		expect(() => serializeContentCatalog({ ...catalog, scope: "public", entries: [catalog.entries[0]!] })).toThrow("public_state_invalid");
		expect(() => serializeContentCatalog({ ...catalog, entries: [{ ...catalog.entries[0], body: "secret" }] })).toThrow("catalog.entries[0].invalid");
		expect(() => serializeContentCatalog({ ...catalog, entries: [catalog.entries[0]!, { ...catalog.entries[1]!, contentId: "content-zeta", locale: "en" }] })).toThrow("identity_duplicate");
		expect(() => serializeContentCatalog({ ...catalog, entries: [catalog.entries[0]!, { ...catalog.entries[1]!, route: catalog.entries[0]!.route }] })).toThrow("route_duplicate");
	});
});
