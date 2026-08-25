/** Provider-neutral, bounded LP allocation and promotion contracts. */
export interface AllocationVariant { id: string; weight: number }
export interface AllocationContract { experimentId: string; experimentRevision: number; variants: AllocationVariant[] }
export interface AllocationResult { variantId: string; bucket: number; experimentRevision: number }
export interface AllocationReceipt extends AllocationResult { version: 1; issuedAt: string; expiresAt: string; allocationDigest: string; signature: string }
export interface AllocationSigner { sign(payload: string): Promise<string> }
export interface AllocationVerifier { verify(payload: string, signature: string): Promise<boolean> }
export interface PromotionEvidence { sourceRevision: number; evidenceRevision: number; expectedEvidenceRevision: number; evidenceId: string; evidenceHash: string; observedAt: string; samples: number; guardrails: Array<{ metricId: string; value: number; maxRegression: number }> }
export interface HumanApproval { actorType: "human"; approvalId: string; actorId: string; approvedAt: string; proposalId: string; experimentId: string; evidenceId: string; evidenceHash: string; selectedVariantId: string; proposalRevision: number; experimentRevision: number; sourceRevision: number; evidenceRevision: number }
export interface PromotionInput { proposalId: string; proposalRevision: number; proposalStatus: "approved"; experimentId: string; experimentRevision: number; experimentStatus: "running" | "completed"; allocation: AllocationContract; selectedVariantId: string; allocationRevision: number; sourceRevision: number; evidence: PromotionEvidence; minSamples: number; humanApproval?: HumanApproval; verifyHuman?: (approval: HumanApproval) => boolean | Promise<boolean>; now: string; changes: Array<{ repository: string; path: string; summary: string }> }
export interface PromotionPlan { kind: "git-change-plan"; planId: string; proposalId: string; experimentId: string; changes: Array<{ repository: string; path: string; summary: string }>; receipt: { planDigest: string; approvalId: string; actorId: string; proposalId: string; experimentId: string; evidenceId: string; evidenceHash: string; selectedVariantId: string; proposalRevision: number; experimentRevision: number; sourceRevision: number; evidenceRevision: number } }

const BUCKETS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const compare = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
	if (v === null || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return false;
	const own = Object.keys(v);
	if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return false;
	return own.every((key) => Object.getOwnPropertyDescriptor(v, key)?.get === undefined && Object.getOwnPropertyDescriptor(v, key)?.set === undefined);
}
const safeRevision = (v: unknown): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function sortedVariants(variants: AllocationVariant[]): AllocationVariant[] {
	const copy = [...variants];
	// oxlint-disable-next-line unicorn/no-array-sort -- ES2022 compatibility requires sorting a defensive copy for canonical allocation order.
	copy.sort(compare);
	return copy;
}
function validatePromotionNumbers(i: PromotionInput): void {
	const e = i.evidence;
	const revisions = [i.proposalRevision, i.experimentRevision, i.allocationRevision, i.sourceRevision, e.sourceRevision, e.evidenceRevision, e.expectedEvidenceRevision];
	if (!ID.test(i.proposalId) || !ID.test(i.experimentId) || revisions.some((value) => !safeRevision(value))) throw new Error("PROMOTION_BINDING_INVALID");
	if (i.humanApproval && (!ID.test(i.humanApproval.approvalId) || !ID.test(i.humanApproval.actorId) || [i.humanApproval.proposalRevision, i.humanApproval.experimentRevision, i.humanApproval.sourceRevision, i.humanApproval.evidenceRevision].some((value) => !safeRevision(value)))) throw new Error("PROMOTION_BINDING_INVALID");
}
function validatePromotionTime(i: PromotionInput): void {
	if (!i.humanApproval) return;
	const observed = Date.parse(i.evidence.observedAt);
	const approved = Date.parse(i.humanApproval.approvedAt);
	const now = Date.parse(i.now);
	if (![observed, approved, now].every(Number.isFinite) || observed > approved || approved > now || approved < now - 86_400_000) throw new Error("PROMOTION_APPROVAL_EXPIRED");
}
function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}
function sortedCopy<T>(values: T[], compareValues: (left: T, right: T) => number): T[] {
	const copy = [...values];
	// oxlint-disable-next-line unicorn(no-array-sort), e18e(prefer-array-to-sorted) -- the package targets ES2022, so canonical sorting uses a defensive copy.
	copy.sort(compareValues);
	return copy;
}
function canonicalPromotionBinding(i: PromotionInput, changes: Array<{ repository: string; path: string; summary: string }>): string {
	const evidence = i.evidence;
	const approval = i.humanApproval;
	if (!approval) throw new Error("PROMOTION_APPROVAL_REQUIRED");
	return JSON.stringify({
		proposalId: i.proposalId,
		experimentId: i.experimentId,
		selectedVariantId: i.selectedVariantId,
		evidence: {
			evidenceId: evidence.evidenceId,
			evidenceHash: evidence.evidenceHash,
			sourceRevision: evidence.sourceRevision,
			evidenceRevision: evidence.evidenceRevision,
			expectedEvidenceRevision: evidence.expectedEvidenceRevision,
			observedAt: evidence.observedAt,
			samples: evidence.samples,
			guardrails: sortedCopy(evidence.guardrails, (left, right) =>
				compareText(left.metricId, right.metricId),
			).map((guardrail) => ({
				metricId: guardrail.metricId,
				value: guardrail.value,
				maxRegression: guardrail.maxRegression,
			})),
		},
		approval: {
			approvalId: approval.approvalId,
			actorId: approval.actorId,
			proposalId: approval.proposalId,
			experimentId: approval.experimentId,
			evidenceId: approval.evidenceId,
			evidenceHash: approval.evidenceHash,
			selectedVariantId: approval.selectedVariantId,
			approvedAt: approval.approvedAt,
			proposalRevision: approval.proposalRevision,
			experimentRevision: approval.experimentRevision,
			sourceRevision: approval.sourceRevision,
			evidenceRevision: approval.evidenceRevision,
		},
		changes: sortedCopy(changes, (left, right) =>
			compareText(`${left.repository}:${left.path}`, `${right.repository}:${right.path}`),
		),
	});
}
function validatePromotionChanges(changes: unknown): asserts changes is Array<{ repository: string; path: string; summary: string }> {
	if (!Array.isArray(changes) || changes.some((change) => !exact(change, ["repository", "path", "summary"]))) throw new Error("PROMOTION_CHANGES_INVALID");
}

function validateAllocation(c: AllocationContract): void {
	if (!exact(c, ["experimentId", "experimentRevision", "variants"]) || !ID.test(c.experimentId) || !safeRevision(c.experimentRevision) || !Array.isArray(c.variants) || c.variants.length < 2 || c.variants.length > 32) throw new Error("ALLOCATION_CONTRACT_INVALID");
	const ids = new Set<string>(); let total = 0;
	for (const v of c.variants) {
		if (!exact(v, ["id", "weight"]) || !ID.test(v.id) || ids.has(v.id) || !Number.isSafeInteger(v.weight) || v.weight < 1 || v.weight > BUCKETS) throw new Error("ALLOCATION_VARIANT_INVALID");
		ids.add(v.id); total += v.weight;
	}
	if (total !== BUCKETS) throw new Error("ALLOCATION_WEIGHTS_INVALID");
}
function variantRange(c: AllocationContract, variantId: string): { start: number; end: number } | undefined {
	let start = 0;
	for (const variant of sortedVariants(c.variants)) {
		if (variant.id === variantId) return { start, end: start + variant.weight };
		start += variant.weight;
	}
	return undefined;
}
export function canonicalizeAllocation(c: AllocationContract): string { validateAllocation(c); return JSON.stringify({ experimentId: c.experimentId, experimentRevision: c.experimentRevision, variants: sortedVariants(c.variants) }); }
function hash32(v: string): number { let h = 2166136261; for (const c of v) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; }
async function sha256(value: string): Promise<string> { if (!globalThis.crypto?.subtle) throw new Error("CRYPTO_UNAVAILABLE"); const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, "0")).join(""); }
function receiptPayload(r: Omit<AllocationReceipt, "signature">): string { return JSON.stringify(r); }

export function allocateExperimentVariant(c: AllocationContract, subject: string): AllocationResult {
	if (typeof subject !== "string" || subject.length < 1 || subject.length > 256) throw new Error("ALLOCATION_SUBJECT_INVALID");
	validateAllocation(c); const bucket = hash32(`${c.experimentId}\0${subject}\0${c.experimentRevision}`) % BUCKETS; let cursor = 0;
	for (const v of sortedVariants(c.variants)) { cursor += v.weight; if (bucket < cursor) return { variantId: v.id, bucket, experimentRevision: c.experimentRevision }; }
	throw new Error("ALLOCATION_BUCKET_UNASSIGNED");
}
export async function issueAllocationReceipt(c: AllocationContract, result: AllocationResult, signer: AllocationSigner, now: string, ttlSeconds: number): Promise<AllocationReceipt> {
	validateAllocation(c); const issued = Date.parse(now); const variant = c.variants.find((v) => v.id === result.variantId);
	const range = variantRange(c, result.variantId);
	if (!variant || !range || !safeRevision(result.experimentRevision) || result.experimentRevision !== c.experimentRevision || !Number.isSafeInteger(result.bucket) || result.bucket < range.start || result.bucket >= range.end || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400 || !Number.isFinite(issued) || !signer || typeof signer.sign !== "function") throw new Error("ALLOCATION_RESULT_INVALID");
	const unsigned = { version: 1 as const, variantId: result.variantId, bucket: result.bucket, experimentRevision: result.experimentRevision, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + ttlSeconds * 1000).toISOString(), allocationDigest: await sha256(canonicalizeAllocation(c)) };
	const signature = await signer.sign(receiptPayload(unsigned)); if (typeof signature !== "string" || signature.length < 1 || signature.length > 512) throw new Error("ALLOCATION_SIGNATURE_INVALID"); return { ...unsigned, signature };
}
export async function verifyAllocationReceipt(c: AllocationContract, r: AllocationReceipt, verifier: AllocationVerifier, now: string, skew = 300): Promise<boolean> {
	try {
		validateAllocation(c); const range = variantRange(c, r.variantId); if (!exact(r, ["version", "variantId", "bucket", "experimentRevision", "issuedAt", "expiresAt", "allocationDigest", "signature"]) || r.version !== 1 || !range || !Number.isSafeInteger(r.bucket) || r.bucket < range.start || r.bucket >= range.end || !safeRevision(r.experimentRevision) || r.experimentRevision !== c.experimentRevision || !HASH.test(r.allocationDigest) || typeof r.signature !== "string" || r.signature.length === 0 || r.signature.length > 512 || !Number.isSafeInteger(skew) || skew < 0 || skew > 86_400 || !verifier) return false;
		const current = Date.parse(now), issued = Date.parse(r.issuedAt), expires = Date.parse(r.expiresAt); if (![current, issued, expires].every(Number.isFinite) || expires <= issued || issued > current + skew * 1000 || current >= expires || r.allocationDigest !== await sha256(canonicalizeAllocation(c))) return false;
		const unsigned = {
			version: r.version,
			variantId: r.variantId,
			bucket: r.bucket,
			experimentRevision: r.experimentRevision,
			issuedAt: r.issuedAt,
			expiresAt: r.expiresAt,
			allocationDigest: r.allocationDigest,
		};
		return typeof verifier.verify === "function" && await verifier.verify(receiptPayload(unsigned), r.signature);
	} catch { return false; }
}

export async function buildPromotionPlan(i: PromotionInput): Promise<PromotionPlan> {
	const e = i.evidence, a = i.humanApproval; validatePromotionNumbers(i); validatePromotionTime(i); validatePromotionChanges(i.changes); validateAllocation(i.allocation);
	if (!exact(e, ["sourceRevision", "evidenceRevision", "expectedEvidenceRevision", "evidenceId", "evidenceHash", "observedAt", "samples", "guardrails"]) || !Array.isArray(e.guardrails) || e.guardrails.some((guardrail) => !exact(guardrail, ["metricId", "value", "maxRegression"])) || (a !== undefined && !exact(a, ["actorType", "approvalId", "actorId", "approvedAt", "proposalId", "experimentId", "evidenceId", "evidenceHash", "selectedVariantId", "proposalRevision", "experimentRevision", "sourceRevision", "evidenceRevision"]))) throw new Error("PROMOTION_SCHEMA_INVALID");
	if (!exact(i, ["proposalId", "proposalRevision", "proposalStatus", "experimentId", "experimentRevision", "experimentStatus", "allocation", "selectedVariantId", "allocationRevision", "sourceRevision", "evidence", "minSamples", "humanApproval", "verifyHuman", "now", "changes"]) || i.proposalStatus !== "approved" || !["running", "completed"].includes(i.experimentStatus) || i.allocation.experimentId !== i.experimentId || i.allocation.experimentRevision !== i.experimentRevision || !i.allocation.variants.some((v) => v.id === i.selectedVariantId) || i.allocationRevision !== i.experimentRevision || !safeRevision(i.proposalRevision) || !safeRevision(i.experimentRevision) || e.sourceRevision !== i.sourceRevision || e.evidenceRevision !== e.expectedEvidenceRevision) throw new Error("PROMOTION_BINDING_INVALID");
	if (!ID.test(e.evidenceId) || !HASH.test(e.evidenceHash) || !Number.isFinite(Date.parse(e.observedAt)) || !Number.isSafeInteger(e.samples) || e.samples < 1 || e.samples > 1_000_000_000 || !Number.isSafeInteger(i.minSamples) || i.minSamples < 1 || i.minSamples > 1_000_000_000 || e.samples < i.minSamples || !Array.isArray(e.guardrails) || e.guardrails.length < 1 || e.guardrails.length > 32 || new Set(e.guardrails.map((g) => g.metricId)).size !== e.guardrails.length || e.guardrails.some((g) => !ID.test(g.metricId) || !Number.isFinite(g.value) || !Number.isFinite(g.maxRegression) || g.maxRegression < 0 || g.value > g.maxRegression)) throw new Error("PROMOTION_EVIDENCE_INVALID");
	if (!a || !exact(a, ["actorType", "approvalId", "actorId", "approvedAt", "proposalId", "experimentId", "evidenceId", "evidenceHash", "selectedVariantId", "proposalRevision", "experimentRevision", "sourceRevision", "evidenceRevision"]) || a.actorType !== "human" || a.proposalId !== i.proposalId || a.experimentId !== i.experimentId || a.evidenceId !== e.evidenceId || a.evidenceHash !== e.evidenceHash || a.selectedVariantId !== i.selectedVariantId || a.proposalRevision !== i.proposalRevision || a.experimentRevision !== i.experimentRevision || a.sourceRevision !== i.sourceRevision || a.evidenceRevision !== e.expectedEvidenceRevision || !i.verifyHuman) throw new Error("PROMOTION_APPROVAL_INVALID");
	if (!await i.verifyHuman(a)) throw new Error("PROMOTION_APPROVAL_INVALID"); const now = Date.parse(i.now), approved = Date.parse(a.approvedAt); if (!Number.isFinite(now) || !Number.isFinite(approved) || approved > now || approved < now - 86_400_000) throw new Error("PROMOTION_APPROVAL_EXPIRED");
	if (!Array.isArray(i.changes) || i.changes.length < 1 || i.changes.length > 32 || i.changes.some((x) => !REPO.test(x.repository) || !x.path || x.path.includes("\\") || x.path.split("/").some((s) => !s || s === "." || s === ".." || Array.from(s, (c) => c.charCodeAt(0)).some((code) => code <= 31 || code === 127)) || !x.summary.trim() || x.summary.length > 512) || new Set(i.changes.map((x) => `${x.repository}:${x.path}`)).size !== i.changes.length) throw new Error("PROMOTION_CHANGES_INVALID");
	const changes = i.changes.map((x) => ({ ...x })); const planDigest = await sha256(canonicalPromotionBinding(i, changes)); return { kind: "git-change-plan", planId: `promotion-${i.proposalId}-${i.proposalRevision}-${planDigest.slice(0, 16)}`, proposalId: i.proposalId, experimentId: i.experimentId, changes, receipt: { planDigest, approvalId: a.approvalId, actorId: a.actorId, proposalId: i.proposalId, experimentId: i.experimentId, evidenceId: e.evidenceId, evidenceHash: e.evidenceHash, selectedVariantId: i.selectedVariantId, proposalRevision: i.proposalRevision, experimentRevision: i.experimentRevision, sourceRevision: i.sourceRevision, evidenceRevision: e.expectedEvidenceRevision } };
}

export interface ProposalClaim { id: string; revision: number; digest: string; payload: Record<string, unknown> }
export interface AtomicProposalBackend { get(id: string): Promise<ProposalClaim | undefined>; claimCanonical(input: ProposalClaim): Promise<ProposalClaimResult> }
export interface AtomicProposalStore { claim(input: ProposalClaim): Promise<ProposalClaimResult>; get(id: string): Promise<ProposalClaim | undefined> }
export interface ProposalClaimResult { accepted: boolean; canonical: ProposalClaim }
function validateJson(value: unknown, depth = 0, seen = new Set<object>()): void {
	if (depth > 8) throw new Error("PROPOSAL_PAYLOAD_DEPTH");
	if (value === null || typeof value === "string" || typeof value === "boolean") { if (typeof value === "string" && new TextEncoder().encode(value).length > 4096) throw new Error("PROPOSAL_PAYLOAD_STRING"); return; }
	if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("PROPOSAL_PAYLOAD_NUMBER"); return; }
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value) || seen.has(value)) throw new Error("PROPOSAL_PAYLOAD_OBJECT");
	seen.add(value); const ownKeys = Reflect.ownKeys(value); if (ownKeys.some((key) => typeof key !== "string")) throw new Error("PROPOSAL_PAYLOAD_KEYS"); const keys = Object.keys(value); if (keys.length > 128 || (Array.isArray(value) && value.length > 128) || ownKeys.length !== keys.length) throw new Error("PROPOSAL_PAYLOAD_KEYS");
	for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || key.length > 128) throw new Error("PROPOSAL_PAYLOAD_ACCESSOR"); validateJson(descriptor.value, depth + 1, seen); }
}
export function createAtomicProposalBackend(): AtomicProposalBackend {
	const records = new Map<string, ProposalClaim>();
	return {
		async get(id) { const value = records.get(id); return value && structuredClone(value); },
		async claimCanonical(input) {
			const old = records.get(input.id);
			const accepted = !old || (old.revision === input.revision && old.digest === input.digest) || old.revision + 1 === input.revision;
			if (accepted && (!old || input.revision > old.revision)) records.set(input.id, structuredClone(input));
			const canonical = records.get(input.id);
			if (!canonical) throw new Error("PROPOSAL_BACKEND_CORRUPT");
			return { accepted, canonical: structuredClone(canonical) };
		},
	};
}
export function createAtomicProposalStore(backend: AtomicProposalBackend = createAtomicProposalBackend()): AtomicProposalStore {
	return {
		async claim(input) {
			if (!exact(input, ["id", "revision", "digest", "payload"]) || !ID.test(input.id) || !safeRevision(input.revision) || !HASH.test(input.digest)) throw new Error("PROPOSAL_CLAIM_INVALID");
			validateJson(input.payload); if (new TextEncoder().encode(JSON.stringify(input.payload)).length > 32_768) throw new Error("PROPOSAL_CLAIM_INVALID");
			const result = await backend.claimCanonical(structuredClone(input));
			if (!result || typeof result.accepted !== "boolean" || !exact(result.canonical, ["id", "revision", "digest", "payload"]) || result.canonical.id !== input.id || !safeRevision(result.canonical.revision) || !HASH.test(result.canonical.digest)) throw new Error("PROPOSAL_BACKEND_CORRUPT");
			validateJson(result.canonical.payload);
			return { accepted: result.accepted, canonical: structuredClone(result.canonical) };
		},
		async get(id) { const value = await backend.get(id); if (!value) return undefined; if (!exact(value, ["id", "revision", "digest", "payload"]) || !ID.test(value.id) || !safeRevision(value.revision) || !HASH.test(value.digest)) throw new Error("PROPOSAL_BACKEND_CORRUPT"); return structuredClone(value); },
	};
}
