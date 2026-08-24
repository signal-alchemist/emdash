import type { MetricSnapshot } from "@signal-alchemist/marketing-automation-contracts";
import type { SandboxedPlugin } from "emdash/plugin";

import {
	normalizeSnapshotEnvelope,
	stableEnvelopeJson,
	type SnapshotEnvelope,
} from "./snapshot-contract.js";

type StoredRecord = Record<string, unknown> & { id: string; targetKey: string; digest: string };
type SnapshotStore = {
	get: (id: string) => Promise<unknown>;
	query: (options?: unknown) => Promise<{ items: Array<{ id?: string; data?: unknown }> }>;
	put: (id: string, value: Record<string, unknown>) => Promise<void>;
};
const MAX_STORED_SNAPSHOTS = 1_000;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function strictStoredTime(value: unknown): boolean {
	if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value)))
		return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}
const COLLECTION_TYPE: Record<string, string> = { posts: "post", pages: "page" };
type ContentTarget = Extract<MetricSnapshot["target"], { kind: "content" }>;

function contentTarget(snapshot: MetricSnapshot): ContentTarget {
	if (snapshot.target.kind !== "content") throw new Error("SNAPSHOT_TARGET_CONTENT_REQUIRED");
	return snapshot.target;
}

function readRecord(input: unknown, kind: "proposal" | "experiment"): StoredRecord {
	if (!input || typeof input !== "object") throw new Error(`${kind} payload is required`);
	const value = input as Record<string, unknown>;
	if (typeof value.id !== "string" || value.id.length === 0)
		throw new Error(`${kind}.id is required`);
	if (typeof value.targetKey !== "string" || value.targetKey.length === 0)
		throw new Error(`${kind}.targetKey is required`);
	return value as StoredRecord;
}

function plain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function digestEnvelope(envelope: SnapshotEnvelope): Promise<string> {
	const bytes = new TextEncoder().encode(stableEnvelopeJson(envelope));
	return globalThis.crypto.subtle
		.digest("SHA-256", bytes)
		.then(
			(digest) =>
				`sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
		);
}

function assertPublishedContent(item: unknown, envelope: SnapshotEnvelope): void {
	if (!plain(item) || item.status !== "published")
		throw new Error("SNAPSHOT_CONTENT_NOT_PUBLISHED");
	const snapshot = envelope.snapshot;
	if (snapshot.target.kind !== "content") throw new Error("SNAPSHOT_TARGET_CONTENT_REQUIRED");
	if (item.id !== snapshot.target.contentId) throw new Error("SNAPSHOT_CONTENT_ID_MISMATCH");
	if (item.locale !== envelope.locale) throw new Error("SNAPSHOT_CONTENT_LOCALE_MISMATCH");
	if (
		typeof item.type !== "string" ||
		item.type.length === 0 ||
		item.type.length > 64 ||
		COLLECTION_TYPE[envelope.collection] !== item.type
	)
		throw new Error("SNAPSHOT_CONTENT_TYPE_INVALID");
	if (typeof item.slug !== "string" || !SAFE_SLUG.test(item.slug))
		throw new Error("SNAPSHOT_CONTENT_SLUG_INVALID");
	if (snapshot.target.path !== `/${envelope.collection}/${item.slug}`)
		throw new Error("SNAPSHOT_CONTENT_PATH_MISMATCH");
}

function storedValue(
	envelope: SnapshotEnvelope,
	digest: string,
	previousDigest?: string,
): Record<string, unknown> {
	const snapshot: MetricSnapshot = envelope.snapshot;
	const target = contentTarget(snapshot);
	const value: Record<string, unknown> = {
		version: snapshot.version,
		snapshotId: snapshot.snapshotId,
		collection: envelope.collection,
		locale: envelope.locale,
		source: envelope.source,
		formulaVersion: envelope.formulaVersion,
		importedAt: envelope.importedAt,
		freshness: envelope.freshness,
		target,
		targetKey: `${target.contentId}:${target.path}`,
		window: snapshot.window,
		definitions: snapshot.definitions,
		funnel: snapshot.funnel,
		custom: snapshot.custom,
		sampleWarnings: snapshot.sampleWarnings,
		generatedAt: snapshot.generatedAt,
		digest,
	};
	if (snapshot.sourceCommit !== undefined) value.sourceCommit = snapshot.sourceCommit;
	if (previousDigest !== undefined) value.previousDigest = previousDigest;
	return value;
}

function sameIdentity(existing: Record<string, unknown>, envelope: SnapshotEnvelope): boolean {
	const target = contentTarget(envelope.snapshot);
	return (
		existing.targetKey === `${target.contentId}:${target.path}` &&
		existing.collection === envelope.collection &&
		existing.locale === envelope.locale &&
		existing.source === envelope.source &&
		existing.formulaVersion === envelope.formulaVersion &&
		JSON.stringify(existing.window) === JSON.stringify(envelope.snapshot.window)
	);
}

function validateExisting(existing: Record<string, unknown>, envelope: SnapshotEnvelope): void {
	if (
		existing.snapshotId !== envelope.snapshot.snapshotId ||
		typeof existing.digest !== "string" ||
		!DIGEST.test(existing.digest) ||
		typeof existing.generatedAt !== "string" ||
		typeof existing.importedAt !== "string" ||
		typeof existing.targetKey !== "string" ||
		!strictStoredTime(existing.generatedAt) ||
		!strictStoredTime(existing.importedAt)
	)
		throw new Error("SNAPSHOT_STORAGE_CORRUPT");
}

async function ingestSnapshot(
	input: unknown,
	getContent: (collection: string, id: string) => Promise<unknown>,
	store: SnapshotStore,
): Promise<Record<string, unknown>> {
	const envelope = normalizeSnapshotEnvelope(input);
	const snapshot = envelope.snapshot;
	const target = contentTarget(snapshot);
	const item = await getContent(envelope.collection, target.contentId).catch(() => {
		throw new Error("SNAPSHOT_CONTENT_READ_FAILED");
	});
	assertPublishedContent(item, envelope);
	const digest = await digestEnvelope(envelope);
	const existingRaw = await store.get(snapshot.snapshotId).catch(() => {
		throw new Error("SNAPSHOT_STORAGE_READ_FAILED");
	});
	if (
		existingRaw !== null &&
		(!plain(existingRaw) ||
			typeof existingRaw.digest !== "string" ||
			typeof existingRaw.targetKey !== "string" ||
			typeof existingRaw.snapshotId !== "string")
	)
		throw new Error("SNAPSHOT_STORAGE_CORRUPT");
	const existing = plain(existingRaw) ? existingRaw : null;
	if (existing) validateExisting(existing, envelope);
	if (existing?.digest === digest && sameIdentity(existing, envelope))
		return { accepted: false, status: "skipped", snapshotId: snapshot.snapshotId, digest };
	if (existing && !sameIdentity(existing, envelope)) throw new Error("SNAPSHOT_CONFLICT");
	if (
		existing &&
		(typeof existing.generatedAt !== "string" ||
			Date.parse(snapshot.generatedAt) <= Date.parse(existing.generatedAt) ||
			typeof existing.importedAt !== "string" ||
			Date.parse(envelope.importedAt) <= Date.parse(existing.importedAt))
	)
		throw new Error("SNAPSHOT_CONFLICT");
	if (!existing) {
		const result = await store.query({ limit: MAX_STORED_SNAPSHOTS + 1 }).catch(() => {
			throw new Error("SNAPSHOT_STORAGE_READ_FAILED");
		});
		if (
			!plain(result) ||
			!Array.isArray(result.items) ||
			result.items.length > MAX_STORED_SNAPSHOTS + 1 ||
			result.items.some((entry) => !plain(entry))
		)
			throw new Error("SNAPSHOT_STORAGE_CORRUPT");
		if (result.items.length >= MAX_STORED_SNAPSHOTS) throw new Error("SNAPSHOT_STORAGE_LIMIT");
	}
	const previousDigest =
		existing && typeof existing.digest === "string" ? existing.digest : undefined;
	const value = storedValue(envelope, digest, previousDigest);
	await store.put(snapshot.snapshotId, value).catch(() => {
		throw new Error("SNAPSHOT_STORAGE_WRITE_FAILED");
	});
	return { accepted: true, replaced: Boolean(existing), snapshotId: snapshot.snapshotId, digest };
}

export default {
	routes: {
		health: {
			handler: async () => ({ ok: true, plugin: "sa-content-insights", phase: "foundation" }),
		},
		ingestSnapshot: {
			handler: async (routeCtx, ctx) => {
				if (!ctx.content?.get) throw new Error("CONTENT_READ_REQUIRED");
				return ingestSnapshot(
					routeCtx.input,
					ctx.content.get.bind(ctx.content),
					ctx.storage.snapshots as SnapshotStore,
				);
			},
		},
		ingestProposal: {
			handler: async (routeCtx, ctx) => {
				const proposal = readRecord(routeCtx.input, "proposal");
				const createdAt =
					typeof proposal.createdAt === "string" ? proposal.createdAt : new Date().toISOString();
				const status = typeof proposal.status === "string" ? proposal.status : "proposed";
				await ctx.storage.proposals.put(proposal.id, { ...proposal, status, createdAt });
				return { accepted: true, proposalId: proposal.id, status, createdAt };
			},
		},
		ingestExperiment: {
			handler: async (routeCtx, ctx) => {
				const experiment = readRecord(routeCtx.input, "experiment");
				const updatedAt = new Date().toISOString();
				const status = typeof experiment.status === "string" ? experiment.status : "draft";
				await ctx.storage.experiments.put(experiment.id, { ...experiment, status, updatedAt });
				return { accepted: true, experimentId: experiment.id, status, updatedAt };
			},
		},
		recent: {
			handler: async (_routeCtx, ctx) => {
				const [snapshots, proposals, experiments] = await Promise.all([
					ctx.storage.snapshots.query({ orderBy: { generatedAt: "desc" }, limit: 10 }),
					ctx.storage.proposals.query({ orderBy: { createdAt: "desc" }, limit: 10 }),
					ctx.storage.experiments.query({ orderBy: { updatedAt: "desc" }, limit: 10 }),
				]);
				return {
					snapshots: snapshots.items,
					proposals: proposals.items,
					experiments: experiments.items,
				};
			},
		},
	},
} satisfies SandboxedPlugin;
