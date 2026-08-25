const MAX_TREE_BYTES = 2_000_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_MEDIA_BYTES = 20_000_000;
const MAX_FILES = 512;
const SHA = /^[0-9a-f]{40}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const CONTENT_ID = /^content-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DELIVERY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ACTOR_ID = /^[1-9][0-9]{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,120}$/;
const PATH = /^(?:content|assets)\/[A-Za-z0-9._/-]{1,240}$/;
const CONTENT_PATH = /^content\/[A-Za-z0-9._/-]+\.md$/;
const MEDIA_PATH = /^assets\/[A-Za-z0-9._/-]+\.(?:avif|gif|jpeg|jpg|png|webp)$/i;
const DECIMAL = /^\d+$/;
const SLUG_FRONTMATTER = /^slug:\s*([a-z0-9][a-z0-9-]{0,62})\s*$/m;
const NON_SLUG = /[^a-z0-9-]+/g;
const TRIM_DASH = /^-|-$/g;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const FIELD = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*?)\s*$/gm;
const LINK = /\]\(([^)]+)\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const IDENTITY_MANIFEST_PATH = "content-manifest.json";
const MEDIA_MANIFEST_PATH = "media-manifest.json";
const MAX_TOTAL_FETCHED_BYTES = 30_000_000;
const MAX_TOTAL_PLAN_BYTES = 5_000_000;

function isCanonicalPath(value: string): boolean {
	if (!PATH.test(value)) return false;
	return value
		.split("/")
		.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasControl(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

function isCanonicalRepository(value: string): boolean {
	if (!REPOSITORY.test(value)) return false;
	return value
		.split("/")
		.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isCanonicalRef(value: string): boolean {
	if (
		!REF.test(value) ||
		value.includes("@{") ||
		value.endsWith(".lock") ||
		value.includes("..") ||
		value.includes("//") ||
		value.endsWith("/")
	)
		return false;
	return value
		.slice("refs/heads/".length)
		.split("/")
		.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function parseContentDocument(
	path: string,
	bytes: Uint8Array,
): ContentIdentityDocument & {
	title: string;
	slug: string;
	body: string;
	updatedAt: string;
	scheduledFor?: string;
	publishState: "draft" | "published" | "scheduled" | "unpublished";
	mediaPaths: string[];
} {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		invalid("content.encoding");
	}
	const frontmatter = text.match(FRONTMATTER)?.[1];
	if (!frontmatter) invalid("frontmatter.invalid");
	const body = text.slice(text.indexOf("\n---\n", 4) + "\n---\n".length);
	const fields = new Map<string, string>();
	for (const match of frontmatter.matchAll(FIELD)) {
		if (fields.has(match[1])) invalid("frontmatter.duplicate_key");
		fields.set(match[1], match[2]);
	}
	const contentId = fields.get("contentId");
	const locale = fields.get("locale");
	const kind = fields.get("type");
	const canonical = fields.get("canonicalRoute");
	const title = fields.get("title");
	const slug = fields.get("slug");
	const publishState = fields.get("publishState") ?? "draft";
	const updatedAt = fields.get("updatedAt");
	const scheduledFor = fields.get("scheduledFor");
	if (
		!contentId ||
		!locale ||
		(kind !== "post" && kind !== "page") ||
		!canonical ||
		!title ||
		!slug ||
		!updatedAt ||
		Number.isNaN(Date.parse(updatedAt)) ||
		new Date(updatedAt).toISOString() !== updatedAt ||
		!["draft", "published", "scheduled", "unpublished"].includes(publishState) ||
		(publishState === "scheduled" &&
			(!scheduledFor ||
				Number.isNaN(Date.parse(scheduledFor)) ||
				new Date(scheduledFor).toISOString() !== scheduledFor)) ||
		(publishState !== "scheduled" && scheduledFor !== undefined)
	)
		invalid("frontmatter.invalid");
	const mediaPaths = Array.from(
		text.matchAll(
			/(?:^|[\s("'])((?:assets)\/[A-Za-z0-9._/-]+\.(?:avif|gif|jpeg|jpg|png|webp))(?:$|[\s)"'])/gim,
		),
		(match) => match[1],
	);
	for (const match of text.matchAll(LINK)) {
		const href = match[1].trim().replace(/^<|>$/g, "");
		const lower = href.toLowerCase();
		const scheme = SCHEME.test(href);
		if (
			hasControl(href) ||
			href.includes("\\") ||
			href.startsWith("//") ||
			(scheme && !lower.startsWith("https://")) ||
			href.split("/").some((segment) => segment === "." || segment === "..")
		)
			invalid("content.unsafe_link");
	}
	return {
		source: { path },
		locale,
		kind,
		contentId,
		canonical,
		title,
		slug,
		body,
		updatedAt,
		scheduledFor,
		publishState: publishState as "draft" | "published" | "scheduled" | "unpublished",
		mediaPaths,
	};
}

export type CatalogEntry = {
	path: string;
	sha: string;
	kind: "content" | "media";
	bytes: number;
	contentHash: string;
	slug?: string;
};

export type ExistingCatalogEntry = Pick<CatalogEntry, "path" | "contentHash"> & {
	contentId?: string;
};

export type SyncPlanAction =
	| { kind: "upsert-content"; path: string; contentHash: string; slug: string }
	| { kind: "upsert-media"; path: string; contentHash: string; bytes: number }
	| { kind: "rename-quarantine"; previousPath: string; currentPath: string }
	| { kind: "removal-quarantine"; path: string };

export type SyncPlan = {
	version: 1;
	repository: string;
	commitSha: string;
	branch: string;
	actions: SyncPlanAction[];
	catalog: CatalogEntry[];
	contentCatalog: string;
	mediaManifest: string;
	commands: ContentSyncCommand[];
	trace: {
		deliveryId: string;
		event: "pull_request";
		repository: string;
		branch: string;
		commitSha: string;
		actorId: string;
		pullRequestNumber: number;
		filesUrl: string;
	};
	totalFetchedBytes: number;
	totalPlanBytes: number;
	planDigest: string;
	planDigestScope: "core-plan-v1";
};

export type PlannerFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function invalid(message: string): never {
	throw new Error(`GITHUB_SYNC_PLAN_INVALID:${message}`);
}

function requireInput(input: unknown): {
	deliveryId: string;
	event: "pull_request";
	repository: string;
	branch: string;
	commitSha: string;
	actorId: string;
	pullRequestNumber: number;
	filesUrl: string;
	previous?: ExistingCatalogEntry[];
} {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		(Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
	)
		invalid("input");
	const value = input as Record<string, unknown>;
	const allowed = new Set([
		"actorId",
		"branch",
		"commitSha",
		"deliveryId",
		"event",
		"filesUrl",
		"previous",
		"pullRequestNumber",
		"repository",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) invalid("input.keys");
	if (
		typeof value.deliveryId !== "string" ||
		!DELIVERY_ID.test(value.deliveryId) ||
		value.event !== "pull_request" ||
		typeof value.repository !== "string" ||
		value.repository.length > 200 ||
		!isCanonicalRepository(value.repository) ||
		typeof value.branch !== "string" ||
		!isCanonicalRef(value.branch) ||
		typeof value.commitSha !== "string" ||
		!SHA.test(value.commitSha) ||
		typeof value.actorId !== "string" ||
		!ACTOR_ID.test(value.actorId) ||
		typeof value.pullRequestNumber !== "number" ||
		!Number.isSafeInteger(value.pullRequestNumber) ||
		value.pullRequestNumber < 1 ||
		value.filesUrl !==
			`https://api.github.com/repos/${value.repository}/pulls/${value.pullRequestNumber}/files`
	)
		invalid("identity");
	if (value.previous === undefined)
		return {
			deliveryId: value.deliveryId,
			event: "pull_request",
			repository: value.repository,
			branch: value.branch,
			commitSha: value.commitSha,
			actorId: value.actorId,
			pullRequestNumber: value.pullRequestNumber,
			filesUrl: value.filesUrl,
		};
	if (!Array.isArray(value.previous) || value.previous.length > MAX_FILES) invalid("previous");
	const previous: ExistingCatalogEntry[] = [];
	const previousPaths = new Set<string>();
	const previousIds = new Set<string>();
	for (const item of value.previous) {
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			(Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
		)
			invalid("previous-entry");
		const entry = item as Record<string, unknown>;
		if (
			Object.keys(entry).some(
				(key) => key !== "path" && key !== "contentHash" && key !== "contentId",
			)
		)
			invalid("previous-entry");
		if (
			typeof entry.path !== "string" ||
			!isCanonicalPath(entry.path) ||
			typeof entry.contentHash !== "string" ||
			!CONTENT_HASH.test(entry.contentHash) ||
			(entry.contentId !== undefined &&
				(typeof entry.contentId !== "string" ||
					!CONTENT_ID.test(entry.contentId) ||
					!entry.path.startsWith("content/")))
		)
			invalid("previous-entry");
		if (
			previousPaths.has(entry.path) ||
			(typeof entry.contentId === "string" && previousIds.has(entry.contentId))
		)
			invalid("previous-duplicate");
		previousPaths.add(entry.path);
		if (typeof entry.contentId === "string") previousIds.add(entry.contentId);
		previous.push({
			path: entry.path,
			contentHash: entry.contentHash,
			contentId: typeof entry.contentId === "string" ? entry.contentId : undefined,
		});
	}
	return {
		deliveryId: value.deliveryId,
		event: "pull_request",
		repository: value.repository,
		branch: value.branch,
		commitSha: value.commitSha,
		actorId: value.actorId,
		pullRequestNumber: value.pullRequestNumber,
		filesUrl: value.filesUrl,
		previous,
	};
}

async function readBounded(
	response: Response,
	maxBytes: number,
	expectedUrl?: string,
): Promise<Uint8Array> {
	if (
		!response.ok ||
		response.redirected ||
		(response.url &&
			(!response.url.startsWith("https://") || (expectedUrl && response.url !== expectedUrl)))
	)
		throw new Error("GITHUB_SYNC_FETCH_FAILED");
	const length = response.headers.get("content-length");
	if (length && (!DECIMAL.test(length) || Number(length) > maxBytes))
		throw new Error("GITHUB_SYNC_RESPONSE_TOO_LARGE");
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const bytes = new Uint8Array(maxBytes + 1);
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error("GITHUB_SYNC_RESPONSE_TOO_LARGE");
			}
			bytes.set(next.value, total - next.value.byteLength);
		}
	} finally {
		reader.releaseLock();
	}
	return bytes.slice(0, total);
}

async function readTree(
	response: Response,
	maxBytes: number,
	expectedUrl: string,
): Promise<{ value: unknown; bytes: number }> {
	const bytes = await readBounded(response, maxBytes, expectedUrl);
	const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json" && contentType !== "text/plain")
		throw new Error("GITHUB_SYNC_CONTENT_TYPE_INVALID");
	try {
		return {
			value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
			bytes: bytes.length,
		};
	} catch {
		throw new Error("GITHUB_SYNC_RESPONSE_INVALID");
	}
}

async function readBytes(
	response: Response,
	maxBytes: number,
	expectedUrl?: string,
): Promise<Uint8Array> {
	return readBounded(response, maxBytes, expectedUrl);
}

export async function hexDigest(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value);
		// oxlint-disable-next-line unicorn(no-array-sort) -- canonical ASCII key order is intentional.
		keys.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function slugFor(path: string, content: Uint8Array): string {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		invalid("content.encoding");
	}
	const match = text.match(SLUG_FRONTMATTER);
	const fallback = path.slice("content/".length, -3).replace(NON_SLUG, "-").replace(TRIM_DASH, "");
	const slug = match?.[1] ?? fallback;
	if (!slug) invalid("content.slug_invalid");
	return slug;
}

export async function buildSyncPlan(input: unknown, fetcher: PlannerFetch): Promise<SyncPlan> {
	const identity = requireInput(input);
	const apiUrl = `https://api.github.com/repos/${identity.repository}/git/trees/${identity.commitSha}?recursive=1`;
	const treeResult = await readTree(
		await fetcher(apiUrl, { method: "GET", redirect: "error" }),
		MAX_TREE_BYTES,
		apiUrl,
	);
	const tree = treeResult.value;
	if (!tree || typeof tree !== "object" || !Array.isArray((tree as Record<string, unknown>).tree))
		invalid("tree");
	if ((tree as Record<string, unknown>).truncated === true) invalid("truncated-tree");
	const files = (tree as { tree: unknown[] }).tree;
	if (files.length > MAX_FILES) invalid("file-count");
	const entries: Array<{ path: string; sha: string; kind: "content" | "media" }> = [];
	const treePaths = new Set<string>();
	let identityManifestPath = false;
	let mediaManifestPath = false;
	for (const file of files) {
		if (!file || typeof file !== "object") invalid("tree-entry");
		const value = file as Record<string, unknown>;
		if (value.type !== "blob" || typeof value.path !== "string" || typeof value.sha !== "string")
			continue;
		if (!SHA.test(value.sha)) invalid("tree-entry");
		if (treePaths.has(value.path)) invalid("tree.duplicate_path");
		treePaths.add(value.path);
		if (value.path === IDENTITY_MANIFEST_PATH) {
			identityManifestPath = true;
			continue;
		}
		if (value.path === MEDIA_MANIFEST_PATH) {
			mediaManifestPath = true;
			continue;
		}
		if (!isCanonicalPath(value.path)) invalid("tree-entry");
		if (CONTENT_PATH.test(value.path))
			entries.push({ path: value.path, sha: value.sha, kind: "content" });
		else if (MEDIA_PATH.test(value.path))
			entries.push({ path: value.path, sha: value.sha, kind: "media" });
		else if (value.path.startsWith("content/") || value.path.startsWith("assets/"))
			invalid("unsupported-file");
	}
	const blobCache = new Map<string, Uint8Array>();
	const blobTypes = new Map<string, string>();
	let totalFetchedBytes = treeResult.bytes;
	const fetchBlob = async (path: string, maxBytes: number): Promise<Uint8Array> => {
		const cached = blobCache.get(path);
		if (cached) return cached;
		const rawUrl = `https://raw.githubusercontent.com/${identity.repository}/${identity.commitSha}/${path}`;
		const response = await fetcher(rawUrl, { method: "GET", redirect: "error" });
		const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
		const expectedType = path.endsWith(".json")
			? "json"
			: path.startsWith("content/")
				? "text/plain"
				: "image/";
		if (
			!contentType ||
			(expectedType === "json"
				? contentType !== "application/json" && contentType !== "text/plain"
				: expectedType === "image/"
					? !contentType.startsWith("image/")
					: contentType !== expectedType)
		)
			throw new Error("GITHUB_SYNC_CONTENT_TYPE_INVALID");
		const bytes = await readBytes(response, maxBytes, rawUrl);
		totalFetchedBytes += bytes.length;
		if (totalFetchedBytes > MAX_TOTAL_FETCHED_BYTES) invalid("fetched_bytes_limit");
		blobCache.set(path, bytes);
		blobTypes.set(path, contentType);
		return bytes;
	};
	if (!identityManifestPath) invalid("identity_manifest_missing");
	let identityManifest: ContentIdentityManifest;
	let documents: ContentIdentityDocument[];
	try {
		const parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				await fetchBlob(IDENTITY_MANIFEST_PATH, MAX_FILE_BYTES),
			),
		) as Record<string, unknown>;
		const keys = Object.keys(parsed);
		// oxlint-disable-next-line unicorn(no-array-sort) -- envelope keys have canonical ASCII order.
		keys.sort();
		if (
			!parsed ||
			typeof parsed !== "object" ||
			keys.join(",") !== "documents,identityManifest" ||
			!parsed.identityManifest ||
			!Array.isArray(parsed.documents)
		)
			invalid("identity_manifest_invalid");
		identityManifest = parsed.identityManifest as ContentIdentityManifest;
		documents = parsed.documents as ContentIdentityDocument[];
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("GITHUB_SYNC_PLAN_INVALID:"))
			throw error;
		invalid("identity_manifest_invalid");
	}
	const identityErrors = validateContentIdentityManifest(
		identityManifest,
		documents!,
		identityManifest!.siteId,
		{ contentRoots: ["content/"] },
	);
	if (identityErrors.length > 0) invalid(identityErrors[0]);
	for (const entry of identityManifest!.entries) {
		if (
			entry.source.repository !== identity.repository ||
			entry.source.branch !== identity.branch ||
			entry.source.commitSha !== identity.commitSha ||
			(entry.source.deliveryId !== undefined && entry.source.deliveryId !== identity.deliveryId)
		)
			invalid("identity_source_mismatch");
	}
	let mediaManifest: MediaManifest | undefined;
	if (mediaManifestPath) {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					await fetchBlob(MEDIA_MANIFEST_PATH, MAX_FILE_BYTES),
				),
			) as Record<string, unknown>;
		} catch {
			invalid("media_manifest_invalid");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			invalid("media_manifest_invalid");
		const keys = Object.keys(parsed!);
		// oxlint-disable-next-line unicorn(no-array-sort) -- envelope keys have canonical ASCII order.
		keys.sort();
		if (
			!parsed ||
			typeof parsed !== "object" ||
			keys.join(",") !== "media,schemaVersion" ||
			parsed.schemaVersion !== 1 ||
			!Array.isArray(parsed.media)
		)
			invalid("media_manifest_invalid");
		mediaManifest = {
			schemaVersion: 1,
			media: parsed.media.map((entry) => validateMediaSourceRef(entry)),
		};
	}
	// oxlint-disable-next-line unicorn(no-array-sort) -- ES2022 package target has no toSorted.
	entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const catalog: CatalogEntry[] = [];
	const contentDocuments: Array<ReturnType<typeof parseContentDocument>> = [];
	for (const entry of entries) {
		const bytes = await fetchBlob(
			entry.path,
			entry.kind === "media" ? MAX_MEDIA_BYTES : MAX_FILE_BYTES,
		);
		if (bytes.length === 0) invalid("empty-file");
		const contentHash = await hexDigest(bytes);
		let document: ReturnType<typeof parseContentDocument> | undefined;
		if (entry.kind === "content") {
			document = parseContentDocument(entry.path, bytes);
			const declared = documents.find((item) => item.source.path === entry.path);
			if (
				!declared ||
				declared.contentId !== document.contentId ||
				declared.locale !== document.locale ||
				declared.kind !== document.kind ||
				declared.canonical !== document.canonical
			)
				invalid("content.catalog_mismatch");
			contentDocuments.push(document);
		}
		catalog.push({
			path: entry.path,
			sha: entry.sha,
			kind: entry.kind,
			bytes: bytes.length,
			contentHash,
			...(document ? { slug: slugFor(entry.path, bytes) } : {}),
		});
	}
	for (const document of documents)
		if (!entries.some((entry) => entry.path === document.source.path))
			invalid("document.blob_missing");
	if (entries.some((entry) => entry.kind === "media") && !mediaManifest)
		invalid("media.manifest_missing");
	const mediaEntries: MediaSourceRef[] = mediaManifest?.media ?? [];
	const normalizedMediaEntries = buildMediaManifest(mediaEntries).media;
	const treeMediaPaths = new Set(
		entries.filter((entry) => entry.kind === "media").map((entry) => entry.path),
	);
	const manifestMediaPaths = new Set(normalizedMediaEntries.map((entry) => entry.sourcePath));
	for (const path of treeMediaPaths)
		if (!manifestMediaPaths.has(path)) invalid("media.manifest_extra_tree");
	for (const path of manifestMediaPaths)
		if (!treeMediaPaths.has(path)) invalid("media.manifest_blob_missing");
	for (const media of normalizedMediaEntries) {
		const entry = entries.find((item) => item.path === media.sourcePath);
		if (!entry) invalid("media.blob_missing");
		const bytes = await fetchBlob(media.sourcePath, MAX_MEDIA_BYTES);
		validateMediaSourceRef(media, bytes);
		if (blobTypes.get(media.sourcePath) !== media.mimeType) invalid("media.mime_mismatch");
		if (media.sha256 !== (await hexDigest(bytes))) invalid("media.sha256_mismatch");
	}
	const mediaPaths = new Set(normalizedMediaEntries.map((entry) => entry.sourcePath));
	for (const document of contentDocuments)
		for (const path of document.mediaPaths)
			if (!mediaPaths.has(path)) invalid("media.reference_missing");
	const previous = identity.previous ?? [];
	const currentPaths = new Set(catalog.map((entry) => entry.path));
	const actions: SyncPlanAction[] = catalog.map((entry) =>
		entry.kind === "content"
			? {
					kind: "upsert-content",
					path: entry.path,
					contentHash: entry.contentHash,
					slug: entry.slug!,
				}
			: {
					kind: "upsert-media",
					path: entry.path,
					contentHash: entry.contentHash,
					bytes: entry.bytes,
				},
	);
	const currentByIdentity = new Map(
		contentDocuments.map((document) => [document.contentId, document.source.path]),
	);
	const previousByIdentity = new Set<string>();
	for (const old of previous) {
		if (currentPaths.has(old.path)) continue;
		if (old.contentId && currentByIdentity.has(old.contentId)) {
			if (previousByIdentity.has(old.contentId)) invalid("ambiguous-rename");
			previousByIdentity.add(old.contentId);
			actions.push({
				kind: "rename-quarantine",
				previousPath: old.path,
				currentPath: currentByIdentity.get(old.contentId)!,
			});
		} else actions.push({ kind: "removal-quarantine", path: old.path });
	}
	actions.sort((left, right) => {
		const a = JSON.stringify(left);
		const b = JSON.stringify(right);
		return a < b ? -1 : a > b ? 1 : 0;
	});
	const catalogEntries = contentDocuments.map((document) => {
		const manifestEntry = identityManifest!.entries.find(
			(entry) => entry.source.path === document.source.path,
		)!;
		return {
			contentId: document.contentId as string,
			locale: document.locale,
			revision: manifestEntry.revision,
			route: document.canonical as string,
			type: document.kind,
			title: document.title,
			publishState: document.publishState === "unpublished" ? "draft" : document.publishState,
			updatedAt: document.updatedAt,
		};
	});
	const contentCatalog: ContentCatalog = {
		schemaVersion: 1,
		siteId: identityManifest!.siteId,
		scope: "internal-draft",
		entries: catalogEntries,
	};
	const commands = contentDocuments.map((document) =>
		validateContentSyncCommand({
			version: 1,
			operation: document.publishState === "unpublished" ? "unpublish" : "upsert",
			source: {
				repository: identity.repository,
				branch: identity.branch,
				path: document.source.path,
				commitSha: identity.commitSha,
				deliveryId: identity.deliveryId,
			},
			collection: `${document.kind}s`,
			contentId: document.contentId,
			slug: document.slug,
			publishState: document.publishState,
			...(document.scheduledFor ? { scheduledFor: document.scheduledFor } : {}),
			fields: {
				title: document.title,
				body: document.body,
				locale: document.locale,
				canonicalRoute: document.canonical,
				updatedAt: document.updatedAt,
			},
			media: normalizedMediaEntries.filter((media) =>
				document.mediaPaths.includes(media.sourcePath),
			),
		}),
	);
	const plan = {
		version: 1 as const,
		repository: identity.repository,
		commitSha: identity.commitSha,
		branch: identity.branch,
		catalog,
		actions,
		contentCatalog: serializeContentCatalog(contentCatalog),
		mediaManifest: serializeMediaManifest(normalizedMediaEntries),
		commands,
	};
	const serialized = stableStringify(plan);
	const serializedBytes = new TextEncoder().encode(serialized);
	if (serializedBytes.byteLength > MAX_TOTAL_PLAN_BYTES) invalid("plan_bytes_limit");
	return {
		...plan,
		trace: {
			deliveryId: identity.deliveryId,
			event: identity.event,
			repository: identity.repository,
			branch: identity.branch,
			commitSha: identity.commitSha,
			actorId: identity.actorId,
			pullRequestNumber: identity.pullRequestNumber,
			filesUrl: identity.filesUrl,
		},
		totalFetchedBytes,
		totalPlanBytes: serializedBytes.byteLength,
		planDigest: await hexDigest(serializedBytes),
		planDigestScope: "core-plan-v1",
	};
}

/** Validate the immutable plan envelope before any write capability is used. */
export async function validateSyncPlan(input: unknown): Promise<SyncPlan> {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Object.prototype
	)
		invalid("apply_input");
	const value = input as Record<string, unknown>;
	// oxlint-disable-next-line unicorn/no-array-sort -- ES2022 compatibility requires in-place sorting of this newly created key array.
	const keys = Object.keys(value).sort().join(",");
	if (
		keys !==
		"actions,branch,catalog,commands,commitSha,contentCatalog,mediaManifest,planDigest,planDigestScope,repository,totalFetchedBytes,totalPlanBytes,trace,version"
	)
		invalid("apply_keys");
	if (
		value.version !== 1 ||
		value.planDigestScope !== "core-plan-v1" ||
		typeof value.repository !== "string" ||
		typeof value.branch !== "string" ||
		typeof value.commitSha !== "string" ||
		!SHA.test(value.commitSha) ||
		typeof value.planDigest !== "string" ||
		!CONTENT_HASH.test(value.planDigest) ||
		!Array.isArray(value.actions) ||
		!Array.isArray(value.catalog) ||
		!Array.isArray(value.commands) ||
		typeof value.contentCatalog !== "string" ||
		typeof value.mediaManifest !== "string" ||
		typeof value.totalFetchedBytes !== "number" ||
		typeof value.totalPlanBytes !== "number"
	)
		invalid("apply_envelope");
	if (
		!Number.isSafeInteger(value.totalFetchedBytes) ||
		value.totalFetchedBytes < 0 ||
		value.totalFetchedBytes > MAX_TOTAL_FETCHED_BYTES ||
		!Number.isSafeInteger(value.totalPlanBytes) ||
		value.totalPlanBytes < 0 ||
		value.totalPlanBytes > MAX_TOTAL_PLAN_BYTES ||
		value.commands.length > MAX_FILES ||
		value.actions.length > MAX_FILES
	)
		invalid("apply_limits");
	const trace = value.trace;
	if (
		!trace ||
		typeof trace !== "object" ||
		Array.isArray(trace) ||
		Object.getPrototypeOf(trace) !== Object.prototype
	)
		invalid("apply_trace");
	const traceValue = trace as Record<string, unknown>;
	if (
		typeof traceValue.deliveryId !== "string" ||
		!DELIVERY_ID.test(traceValue.deliveryId) ||
		traceValue.event !== "pull_request" ||
		traceValue.repository !== value.repository ||
		traceValue.branch !== value.branch ||
		traceValue.commitSha !== value.commitSha ||
		typeof traceValue.actorId !== "string" ||
		!ACTOR_ID.test(traceValue.actorId) ||
		typeof traceValue.pullRequestNumber !== "number" ||
		!Number.isSafeInteger(traceValue.pullRequestNumber) ||
		traceValue.pullRequestNumber < 1 ||
		traceValue.filesUrl !==
			`https://api.github.com/repos/${value.repository}/pulls/${traceValue.pullRequestNumber}/files`
	)
		invalid("apply_trace");
	const commands = value.commands.map((command) => validateContentSyncCommand(command));
	for (const command of commands) {
		if (
			command.source.repository !== value.repository ||
			command.source.branch !== value.branch ||
			command.source.commitSha !== value.commitSha ||
			command.source.deliveryId !== traceValue.deliveryId
		)
			invalid("apply_source");
	}
	const core = {
		version: 1 as const,
		repository: value.repository,
		commitSha: value.commitSha,
		branch: value.branch,
		catalog: value.catalog,
		actions: value.actions,
		contentCatalog: value.contentCatalog,
		mediaManifest: value.mediaManifest,
		commands,
	};
	const bytes = new TextEncoder().encode(stableStringify(core));
	if (bytes.byteLength !== value.totalPlanBytes || (await hexDigest(bytes)) !== value.planDigest)
		invalid("apply_digest");
	return {
		...core,
		trace: traceValue as SyncPlan["trace"],
		totalFetchedBytes: value.totalFetchedBytes,
		totalPlanBytes: value.totalPlanBytes,
		planDigest: value.planDigest,
		planDigestScope: "core-plan-v1",
	};
}
import {
	buildMediaManifest,
	serializeContentCatalog,
	serializeMediaManifest,
	validateContentSyncCommand,
	validateContentIdentityManifest,
	validateMediaSourceRef,
	type ContentCatalog,
	type ContentIdentityDocument,
	type ContentIdentityManifest,
	type MediaManifest,
	type MediaSourceRef,
	type ContentSyncCommand,
} from "@signal-alchemist/marketing-automation-contracts";
