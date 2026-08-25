import { describe, expect, it, vi } from "vitest";

import plugin from "../src/sandbox-entry.js";

type Handler = (request: { input: unknown; user?: unknown }, ctx: unknown) => Promise<unknown>;
const route = (name: "ingestProposal" | "ingestExperiment") =>
	plugin.routes[name].handler as unknown as Handler;
const evidence = {
	snapshotId: "snapshot-1",
	digest: `sha256:${"a".repeat(64)}`,
	contentId: "content-alpha",
	path: "/posts/alpha",
	locale: "en",
	source: "gsc",
	formulaVersion: "gsc-search-analytics-v1",
	window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-07T00:00:00.000Z" },
};
const common = {
	version: 1,
	id: "record-1",
	revision: 0,
	targetKey: "content-alpha:/posts/alpha",
	content: { collection: "posts", id: "content-alpha", path: "/posts/alpha" },
	locale: "en",
	evidence,
};
const proposal = {
	...common,
	status: "proposed",
	changes: [{ path: "src/copy.md", hash: `sha256:${"b".repeat(64)}` }],
	risks: [{ id: "risk-1", severity: "low", mitigation: "Review" }],
	verification: [{ id: "verify-1", method: "Compare snapshot", threshold: 0.1 }],
};
const experiment = {
	...common,
	status: "draft",
	hypothesis: "Improve conversion",
	variants: [
		{ id: "control", label: "Control", allocation: 0.5 },
		{ id: "variant", label: "Variant", allocation: 0.5 },
	],
	metrics: [{ id: "conversion", unit: "ratio", definitionId: "conversion" }],
};
const finalDecision = {
	outcome: "winner",
	rationale: "Evidence is sufficient",
	evidence: ["snapshot-1"],
};
const experimentStates = [
	"draft",
	"ready",
	"running",
	"observing",
	"decided",
	"reverted",
	"cancelled",
] as const;
const experimentAllowed = new Set([
	"draft>ready",
	"draft>cancelled",
	"ready>running",
	"ready>cancelled",
	"running>observing",
	"running>cancelled",
	"observing>decided",
	"observing>reverted",
	"observing>cancelled",
	"decided>reverted",
]);
const proposalStates = [
	"proposed",
	"needs_review",
	"approved",
	"rejected",
	"implemented",
	"measuring",
	"accepted",
	"reverted",
	"inconclusive",
] as const;
const proposalAllowed = new Set([
	"proposed>needs_review",
	"proposed>approved",
	"proposed>rejected",
	"needs_review>approved",
	"needs_review>rejected",
	"approved>implemented",
	"approved>rejected",
	"implemented>measuring",
	"measuring>accepted",
	"measuring>inconclusive",
	"measuring>reverted",
	"accepted>reverted",
]);
const forbiddenExperimentTransitions = experimentStates.flatMap((from) =>
	experimentStates
		.filter((to) => !experimentAllowed.has(`${from}>${to}`))
		.map((to) => [from, to] as const),
);
const forbiddenProposalTransitions = proposalStates.flatMap((from) =>
	proposalStates
		.filter((to) => !proposalAllowed.has(`${from}>${to}`))
		.map((to) => [from, to] as const),
);
function storedFixture(existing: unknown): Record<string, unknown> {
	const value = existing as Record<string, unknown>;
	const status = String(value.status);
	const isExperiment = "variants" in value;
	const final = isExperiment
		? ["decided", "reverted", "cancelled"].includes(status)
		: ["approved", "rejected", "accepted", "reverted", "inconclusive"].includes(status);
	const outcome = status === "decided" ? "winner" : status;
	return {
		createdAt: "2026-08-09T00:00:00.000Z",
		updatedAt: "2026-08-10T00:00:00.000Z",
		...value,
		...(final && value.decision === undefined
			? { decision: { outcome, rationale: "prior decision", evidence: ["snapshot-1"] } }
			: {}),
		...(final && value.actor === undefined ? { actor: { id: "editor-1", type: "human" } } : {}),
	};
}
function context(existing: unknown = null) {
	let stored = existing === null ? null : storedFixture(existing);
	const claims = new Map<string, unknown>();
	const put = vi.fn(async (_id: string, value: unknown) => {
		stored = value;
	});
	const snapshot = {
		version: 1,
		snapshotId: "snapshot-1",
		collection: "posts",
		locale: "en",
		source: "gsc",
		formulaVersion: "gsc-search-analytics-v1",
		importedAt: "2026-08-09T00:00:00.000Z",
		freshness: { observedAt: "2026-08-08T00:00:00.000Z", maxAgeSeconds: 86400 },
		target: { kind: "content", contentId: "content-alpha", path: "/posts/alpha" },
		targetKey: "content-alpha:/posts/alpha",
		window: evidence.window,
		definitions: [
			{ id: "clicks", label: "Clicks", unit: "count", source: "gsc-search-analytics-v1" },
		],
		funnel: { clicks: 1 },
		custom: {},
		sampleWarnings: [],
		generatedAt: "2026-08-08T00:00:00.000Z",
		digest: evidence.digest,
	};
	return {
		put,
		ctx: {
			content: {
				get: vi.fn(async () => ({
					id: "content-alpha",
					status: "published",
					locale: "en",
					type: "post",
					slug: "alpha",
				})),
			},
			storage: {
				snapshots: { get: vi.fn(async () => snapshot) },
				proposals: {
					get: vi.fn(async () => stored),
					create: vi.fn(async (_id: string, value: unknown) => {
						if (stored !== null) return false;
						stored = value;
						return true;
					}),
					put,
				},
				experiments: {
					get: vi.fn(async () => stored),
					create: vi.fn(async (_id: string, value: unknown) => {
						if (stored !== null) return false;
						stored = value;
						return true;
					}),
					put,
				},
				record_claims: {
					get: vi.fn(async (id: string) => claims.get(id) ?? null),
					create: vi.fn(async (id: string, value: unknown) => {
						if (claims.has(id)) return false;
						claims.set(id, value);
						return true;
					}),
					put: vi.fn(async (id: string, value: unknown) => {
						claims.set(id, value);
					}),
				},
			},
		},
	};
}
function barrier(parties: number) {
	let arrivals = 0;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return async () => {
		arrivals += 1;
		if (arrivals === parties) release();
		await ready;
	};
}
function sharedRace(
	initial: Record<string, unknown> | null,
	options: {
		targetCreateBarrier?: boolean;
		targetGetBarrier?: boolean;
		claimCreateBarrier?: boolean;
	} = {},
) {
	const target = new Map<string, Record<string, unknown>>();
	if (initial) target.set(String(initial.id), storedFixture(initial));
	const claims = new Map<string, Record<string, unknown>>();
	const waitTargetCreate = options.targetCreateBarrier ? barrier(2) : undefined;
	const waitTargetGet = options.targetGetBarrier ? barrier(2) : undefined;
	const waitClaimCreate = options.claimCreateBarrier ? barrier(2) : undefined;
	let failNextTargetPut = false;
	let targetPutCalls = 0;
	let targetCreateCalls = 0;
	const makeContext = () => {
		const base = context().ctx;
		const targetStore = {
			get: async (id: string) => {
				if (waitTargetGet) await waitTargetGet();
				return target.get(id) ?? null;
			},
			create: async (id: string, value: Record<string, unknown>) => {
				targetCreateCalls += 1;
				if (waitTargetCreate) await waitTargetCreate();
				if (target.has(id)) return false;
				target.set(id, structuredClone(value));
				return true;
			},
			put: async (id: string, value: Record<string, unknown>) => {
				targetPutCalls += 1;
				if (failNextTargetPut) {
					failNextTargetPut = false;
					throw new Error("target unavailable");
				}
				target.set(id, structuredClone(value));
			},
		};
		const claimStore = {
			get: async (id: string) => claims.get(id) ?? null,
			create: async (id: string, value: Record<string, unknown>) => {
				if (waitClaimCreate) await waitClaimCreate();
				if (claims.has(id)) return false;
				claims.set(id, structuredClone(value));
				return true;
			},
			put: async (id: string, value: Record<string, unknown>) => {
				claims.set(id, structuredClone(value));
			},
		};
		return {
			...base,
			storage: {
				...base.storage,
				proposals: targetStore,
				experiments: targetStore,
				record_claims: claimStore,
			},
		};
	};
	return {
		claims,
		makeContext,
		target,
		failNextPut: () => {
			failNextTargetPut = true;
		},
		stats: () => ({ targetCreateCalls, targetPutCalls }),
	};
}
describe("versioned experiment and proposal records", () => {
	it("accepts exact proposal and experiment schemas", async () => {
		expect(await route("ingestProposal")({ input: proposal }, context().ctx)).toMatchObject({
			accepted: true,
			revision: 0,
		});
		expect(await route("ingestExperiment")({ input: experiment }, context().ctx)).toMatchObject({
			accepted: true,
		});
	});
	it("rejects cross-kind fields and excess/custom prototypes before storage", async () => {
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, variants: experiment.variants } },
				context().ctx,
			),
		).rejects.toThrow("RECORD_PROPOSAL_EXCESS");
		await expect(
			route("ingestExperiment")(
				{ input: { ...experiment, changes: proposal.changes } },
				context().ctx,
			),
		).rejects.toThrow("RECORD_EXPERIMENT_EXCESS");
		const polluted = Object.create({ secret: "credential" });
		Object.assign(polluted, proposal);
		await expect(route("ingestProposal")({ input: polluted }, context().ctx)).rejects.toThrow(
			"RECORD_INPUT_EXCESS",
		);
	});
	it("rejects missing or mismatched evidence and content", async () => {
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, evidence: { ...evidence, digest: "bad" } } },
				context().ctx,
			),
		).rejects.toThrow("RECORD_EVIDENCE_INVALID");
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, content: { ...proposal.content, collection: "pages" } } },
				context().ctx,
			),
		).rejects.toThrow("RECORD_CONTENT_NOT_PUBLISHED");
	});
	it("binds final decisions to independently supplied trusted UserInfo", async () => {
		const existing = { ...experiment, status: "observing", revision: 1 };
		await expect(
			route("ingestExperiment")(
				{ input: { ...experiment, status: "decided", revision: 2, decision: finalDecision } },
				context(existing).ctx,
			),
		).rejects.toThrow("RECORD_HUMAN_ACTOR_UNTRUSTED");
		await expect(
			route("ingestExperiment")(
				{
					input: {
						...experiment,
						status: "decided",
						revision: 2,
						decision: finalDecision,
						actor: { id: "spoof" },
					},
					user: {
						id: "editor-1",
						email: "e",
						name: null,
						role: 1,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				},
				context(existing).ctx,
			),
		).rejects.toThrow("RECORD_ACTOR_UNTRUSTED");
		await expect(
			route("ingestExperiment")(
				{
					input: { ...experiment, status: "decided", revision: 2, decision: finalDecision },
					user: {
						id: "editor-1",
						email: "e",
						name: null,
						role: 1,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				},
				context(existing).ctx,
			),
		).resolves.toMatchObject({ accepted: true, status: "decided" });
	});
	it("requires structured final decision fields", async () => {
		const existing = { ...experiment, status: "observing", revision: 1 };
		await expect(
			route("ingestExperiment")(
				{
					input: { ...experiment, status: "decided", revision: 2, decision: "winner" },
					user: { id: "editor-1" },
				},
				context(existing).ctx,
			),
		).rejects.toThrow("RECORD_HUMAN_DECISION_REQUIRED");
	});
	it("supports exact replay and rejects stale or invalid transitions", async () => {
		const c = context(proposal);
		expect(await route("ingestProposal")({ input: proposal }, c.ctx)).toMatchObject({
			accepted: false,
			status: "skipped",
		});
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, status: "measuring", revision: 1 } },
				context(proposal).ctx,
			),
		).rejects.toThrow("RECORD_REVISION_CONFLICT");
	});
	it("validates nested fields, windows, and bounds without storing secrets", async () => {
		await expect(
			route("ingestExperiment")(
				{ input: { ...experiment, variants: [{ id: "v", label: "V", allocation: 2 }] } },
				context().ctx,
			),
		).rejects.toThrow("RECORD_VARIANTS_INVALID");
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, changes: [{ path: "x", hash: "bad" }] } },
				context().ctx,
			),
		).rejects.toThrow("RECORD_CHANGES_INVALID");
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, window: { from: "bad", to: evidence.window.to } } },
				context().ctx,
			),
		).rejects.toThrow("RECORD_WINDOW_INVALID");
		const c = context();
		await route("ingestProposal")({ input: proposal }, c.ctx);
		const created = (c.ctx.storage.proposals.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		expect(JSON.stringify(created)).not.toMatch(
			/body|credential|provider|visitor|function|script/u,
		);
	});
	it("surfaces storage failures", async () => {
		const c = context();
		c.ctx.storage.proposals.get = vi.fn(async () => {
			throw new Error("db");
		});
		await expect(route("ingestProposal")({ input: proposal }, c.ctx)).rejects.toThrow(
			"RECORD_STORAGE_READ_FAILED",
		);
	});
	it.each([
		["target create", "RECORD_STORAGE_CREATE_FAILED"],
		["target put", "RECORD_STORAGE_WRITE_FAILED"],
		["claim create", "RECORD_CLAIM_CREATE_FAILED"],
		["claim get", "RECORD_CLAIM_READ_FAILED"],
		["claim put", "RECORD_CLAIM_WRITE_FAILED"],
	] as const)("fails closed when %s fails", async (failure, code) => {
		const updating = failure !== "target create";
		const c = context(updating ? proposal : null);
		const target = c.ctx.storage.proposals as {
			create: ReturnType<typeof vi.fn>;
			put: ReturnType<typeof vi.fn>;
		};
		const claims = c.ctx.storage.record_claims as {
			create: ReturnType<typeof vi.fn>;
			get: ReturnType<typeof vi.fn>;
			put: ReturnType<typeof vi.fn>;
		};
		if (failure === "target create") target.create.mockRejectedValue(new Error("db"));
		if (failure === "target put") target.put.mockRejectedValue(new Error("db"));
		if (failure === "claim create") claims.create.mockRejectedValue(new Error("db"));
		if (failure === "claim get") {
			claims.create.mockResolvedValue(false);
			claims.get.mockRejectedValue(new Error("db"));
		}
		if (failure === "claim put") claims.put.mockRejectedValue(new Error("db"));
		const input = updating ? { ...proposal, revision: 1, status: "needs_review" } : proposal;
		await expect(route("ingestProposal")({ input }, c.ctx)).rejects.toThrow(code);
	});
	it.each(["unknown field", "oversized"] as const)("rejects a %s revision claim", async (kind) => {
		const c = context(proposal);
		const claims = c.ctx.storage.record_claims as {
			create: ReturnType<typeof vi.fn>;
			get: ReturnType<typeof vi.fn>;
		};
		claims.create.mockResolvedValue(false);
		claims.get.mockResolvedValue(
			kind === "unknown field"
				? {
						version: 1,
						kind: "proposal",
						recordId: proposal.id,
						revision: 1,
						digest: `sha256:${"0".repeat(64)}`,
						record: {},
						extra: true,
					}
				: {
						version: 1,
						kind: "proposal",
						recordId: proposal.id,
						revision: 1,
						digest: `sha256:${"0".repeat(64)}`,
						record: { padding: "x".repeat(33_000) },
					},
		);
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, revision: 1, status: "needs_review" } },
				c.ctx,
			),
		).rejects.toThrow("RECORD_CLAIM_CORRUPT");
	});
	it.each(["unknown", "non-object"] as const)("rejects %s corrupt target records", async (kind) => {
		const c = context();
		c.ctx.storage.proposals.get = vi.fn(async () =>
			kind === "unknown" ? { ...storedFixture(proposal), extra: true } : "bad",
		);
		await expect(route("ingestProposal")({ input: proposal }, c.ctx)).rejects.toThrow(
			"RECORD_STORAGE_CORRUPT",
		);
	});
	it("rejects symbols, accessors, non-enumerable fields, and polluted prototypes before reads", async () => {
		const symbolInput = { ...proposal } as Record<string | symbol, unknown>;
		symbolInput[Symbol("secret")] = "nope";
		const c = context();
		await expect(route("ingestProposal")({ input: symbolInput }, c.ctx)).rejects.toThrow(
			"RECORD_INPUT_EXCESS",
		);
		const accessor = { ...proposal } as Record<string, unknown>;
		Object.defineProperty(accessor, "idempotencyKey", { enumerable: true, get: () => "key" });
		await expect(route("ingestProposal")({ input: accessor }, c.ctx)).rejects.toThrow(
			"RECORD_INPUT_EXCESS",
		);
		const hidden = { ...proposal } as Record<string, unknown>;
		Object.defineProperty(hidden, "secret", { enumerable: false, value: "x" });
		await expect(route("ingestProposal")({ input: hidden }, c.ctx)).rejects.toThrow(
			"RECORD_INPUT_EXCESS",
		);
		const polluted = Object.create({ inherited: true });
		Object.assign(polluted, proposal);
		await expect(route("ingestProposal")({ input: polluted }, c.ctx)).rejects.toThrow(
			"RECORD_INPUT_EXCESS",
		);
	});
	it("keeps identity and timestamps host-controlled and requires the bound user", async () => {
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, createdAt: evidence.window.from } },
				context().ctx,
			),
		).rejects.toThrow("RECORD_TIME_UNTRUSTED");
		const existing = { ...experiment, status: "observing", revision: 1 };
		await expect(
			route("ingestExperiment")(
				{ input: { ...experiment, status: "decided", revision: 2, decision: finalDecision } },
				context(existing).ctx,
			),
		).rejects.toThrow("RECORD_HUMAN_ACTOR_UNTRUSTED");
	});
	it("rejects idempotency conflicts and preserves the caller input", async () => {
		const first = { ...proposal, idempotencyKey: "same-key" };
		const c = context();
		const before = JSON.stringify(first);
		await route("ingestProposal")({ input: first }, c.ctx);
		expect(JSON.stringify(first)).toBe(before);
		await expect(
			route("ingestProposal")(
				{ input: { ...first, changes: [{ path: "other", hash: `sha256:${"c".repeat(64)}` }] } },
				c.ctx,
			),
		).rejects.toThrow("RECORD_IDEMPOTENCY_CONFLICT");
	});
	it("uses independent recent cursors and returns safe kind-specific projections", async () => {
		const recent = plugin.routes.recent.handler as unknown as Handler;
		const snapshot = context().ctx.storage.snapshots.get;
		let queryCall = 0;
		const query = vi.fn(async (options: { cursor?: string }) => ({
			items: [
				{
					id: "record-1",
					data: {
						...(queryCall++ === 0 ? proposal : experiment),
						createdAt: "2026-08-09T00:00:00.000Z",
						updatedAt: "2026-08-10T00:00:00.000Z",
					},
				},
			],
			cursor: options.cursor ? undefined : "next",
			hasMore: false,
		}));
		const result = await recent(
			{ input: { limit: 1, cursor: { proposals: "p", experiments: "e" } } },
			{
				content: context().ctx.content,
				storage: { snapshots: { get: snapshot }, proposals: { query }, experiments: { query } },
			},
		);
		expect(result).toMatchObject({
			proposals: [{ changes: proposal.changes }],
			experiments: [{ variants: experiment.variants }],
		});
		expect(query.mock.calls[0]?.[0]).toMatchObject({ cursor: "p" });
		expect(query.mock.calls[1]?.[0]).toMatchObject({ cursor: "e" });
	});
	it.each([
		["draft", "ready"],
		["draft", "cancelled"],
		["ready", "running"],
		["ready", "cancelled"],
		["running", "observing"],
		["running", "cancelled"],
		["observing", "decided"],
		["observing", "reverted"],
		["observing", "cancelled"],
		["decided", "reverted"],
	])("accepts experiment transition %s -> %s", async (from, to) => {
		const decision =
			to === "decided"
				? finalDecision
				: to === "reverted"
					? { ...finalDecision, outcome: "reverted" }
					: to === "cancelled"
						? { ...finalDecision, outcome: "cancelled" }
						: undefined;
		const input = { ...experiment, status: to, revision: 2, ...(decision ? { decision } : {}) };
		await expect(
			route("ingestExperiment")(
				{ input, user: { id: "editor-1" } },
				context({ ...experiment, status: from, revision: 1 }).ctx,
			),
		).resolves.toMatchObject({ accepted: true });
	});
	it.each([
		["proposed", "needs_review"],
		["proposed", "approved"],
		["proposed", "rejected"],
		["needs_review", "approved"],
		["needs_review", "rejected"],
		["approved", "implemented"],
		["approved", "rejected"],
		["implemented", "measuring"],
		["measuring", "accepted"],
		["measuring", "inconclusive"],
		["measuring", "reverted"],
		["accepted", "reverted"],
	])("accepts proposal transition %s -> %s", async (from, to) => {
		const decision = ["approved", "rejected", "accepted", "inconclusive", "reverted"].includes(to)
			? { outcome: to, rationale: "reason", evidence: ["snapshot-1"] }
			: undefined;
		await expect(
			route("ingestProposal")(
				{
					input: { ...proposal, status: to, revision: 2, ...(decision ? { decision } : {}) },
					user: { id: "editor-1" },
				},
				context({ ...proposal, status: from, revision: 1 }).ctx,
			),
		).resolves.toMatchObject({ accepted: true });
	});
	it.each(forbiddenExperimentTransitions)(
		"rejects forbidden experiment transition %s -> %s",
		async (from, to) => {
			const outcome = to === "reverted" ? "reverted" : to === "cancelled" ? "cancelled" : "winner";
			const decision = ["decided", "reverted", "cancelled"].includes(to)
				? { ...finalDecision, outcome }
				: undefined;
			await expect(
				route("ingestExperiment")(
					{
						input: { ...experiment, status: to, revision: 2, ...(decision ? { decision } : {}) },
						user: { id: "editor-1" },
					},
					context({ ...experiment, status: from, revision: 1 }).ctx,
				),
			).rejects.toThrow("RECORD_REVISION_CONFLICT");
		},
	);
	it.each(forbiddenProposalTransitions)(
		"rejects forbidden proposal transition %s -> %s",
		async (from, to) => {
			const decision = ["approved", "rejected", "accepted", "inconclusive", "reverted"].includes(to)
				? { outcome: to, rationale: "reason", evidence: ["snapshot-1"] }
				: undefined;
			await expect(
				route("ingestProposal")(
					{
						input: { ...proposal, status: to, revision: 2, ...(decision ? { decision } : {}) },
						user: { id: "editor-1" },
					},
					context({ ...proposal, status: from, revision: 1 }).ctx,
				),
			).rejects.toThrow("RECORD_REVISION_CONFLICT");
		},
	);
	it("rejects forged freshness and uncertainty and enforces the collection cap", async () => {
		await expect(
			route("ingestProposal")(
				{
					input: {
						...proposal,
						evidence: {
							...evidence,
							freshness: { observedAt: evidence.window.to, maxAgeSeconds: 1 },
						},
					},
				},
				context().ctx,
			),
		).rejects.toThrow("RECORD_EVIDENCE_INVALID");
		const c = context();
		(c.ctx.storage.proposals as { count?: () => Promise<number> }).count = vi.fn(async () => 1000);
		await expect(route("ingestProposal")({ input: proposal }, c.ctx)).rejects.toThrow(
			"RECORD_STORAGE_LIMIT",
		);
	});
	it("rejects oversized nested arrays and serialized payloads before storage", async () => {
		await expect(
			route("ingestExperiment")(
				{
					input: {
						...experiment,
						variants: Array.from({ length: 51 }, (_, i) => ({
							id: `v${i}`,
							label: "v",
							allocation: 1 / 51,
						})),
					},
				},
				context().ctx,
			),
		).rejects.toThrow("RECORD_VARIANTS_INVALID");
		await expect(
			route("ingestProposal")(
				{
					input: {
						...proposal,
						changes: Array.from({ length: 100 }, () => ({
							path: "x".repeat(256),
							hash: `sha256:${"a".repeat(64)}`,
						})),
					},
				},
				context().ctx,
			),
		).rejects.toThrow("RECORD_INPUT_TOO_LARGE");
	});
	it("converges duplicate create races and reports a missing winner deterministically", async () => {
		const c = context();
		const winner = {
			...proposal,
			createdAt: "2026-08-09T00:00:00.000Z",
			updatedAt: "2026-08-10T00:00:00.000Z",
		};
		(
			c.ctx.storage.proposals as {
				create?: () => Promise<boolean>;
				get: (id: string) => Promise<unknown>;
			}
		).create = vi.fn(async () => false);
		c.ctx.storage.proposals.get = vi.fn(async () => winner);
		await expect(route("ingestProposal")({ input: proposal }, c.ctx)).resolves.toMatchObject({
			accepted: false,
			status: "skipped",
		});
		const missing = context();
		(
			missing.ctx.storage.proposals as {
				create?: () => Promise<boolean>;
				get: (id: string) => Promise<unknown>;
			}
		).create = vi.fn(async () => false);
		missing.ctx.storage.proposals.get = vi.fn(async () => null);
		await expect(route("ingestProposal")({ input: proposal }, missing.ctx)).rejects.toThrow(
			"RECORD_REVISION_CONFLICT",
		);
	});
	it("atomically converges identical initial creates from two independent contexts", async () => {
		const shared = sharedRace(null, { targetCreateBarrier: true });
		const [first, second] = await Promise.all([
			route("ingestProposal")({ input: proposal }, shared.makeContext()),
			route("ingestProposal")({ input: proposal }, shared.makeContext()),
		]);
		expect(
			[first, second].filter((result) => (result as { accepted: boolean }).accepted),
		).toHaveLength(1);
		expect(
			[first, second].filter((result) => !(result as { accepted: boolean }).accepted),
		).toHaveLength(1);
		expect(shared.stats()).toEqual({ targetCreateCalls: 2, targetPutCalls: 0 });
		expect(shared.target.get(proposal.id)).toMatchObject({ status: "proposed", revision: 0 });
	});
	it("allows exactly one different initial create and never overwrites the winner", async () => {
		const shared = sharedRace(null, { targetCreateBarrier: true });
		const other = {
			...proposal,
			changes: [{ path: "src/other.md", hash: `sha256:${"c".repeat(64)}` }],
		};
		const results = await Promise.allSettled([
			route("ingestProposal")({ input: proposal }, shared.makeContext()),
			route("ingestProposal")({ input: other }, shared.makeContext()),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find(
			(result) => result.status === "rejected",
		) as PromiseRejectedResult;
		expect(String(rejected.reason)).toContain("RECORD_REVISION_CONFLICT");
		expect(shared.stats()).toEqual({ targetCreateCalls: 2, targetPutCalls: 0 });
		const winner = shared.target.get(proposal.id);
		expect(winner).toBeDefined();
		expect([proposal.changes[0]?.path, other.changes[0]?.path]).toContain(
			(winner?.changes as Array<{ path: string }> | undefined)?.[0]?.path,
		);
	});
	it("serializes different same-revision updates through a shared atomic claim", async () => {
		const shared = sharedRace(proposal, { targetGetBarrier: true, claimCreateBarrier: true });
		const first = { ...proposal, revision: 1, status: "needs_review" };
		const second = {
			...first,
			changes: [{ path: "src/other.md", hash: `sha256:${"c".repeat(64)}` }],
		};
		const results = await Promise.allSettled([
			route("ingestProposal")({ input: first }, shared.makeContext()),
			route("ingestProposal")({ input: second }, shared.makeContext()),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find(
			(result) => result.status === "rejected",
		) as PromiseRejectedResult;
		expect(String(rejected.reason)).toContain("RECORD_REVISION_CONFLICT");
		expect(shared.stats().targetPutCalls).toBe(1);
		const claim = [...shared.claims.values()][0];
		expect(shared.target.get(proposal.id)).toEqual(claim?.record);
	});
	it("converges identical same-revision updates and subsequently skips exact replay", async () => {
		const shared = sharedRace(proposal, { targetGetBarrier: true, claimCreateBarrier: true });
		const update = { ...proposal, revision: 1, status: "needs_review" };
		const concurrent = await Promise.all([
			route("ingestProposal")({ input: update }, shared.makeContext()),
			route("ingestProposal")({ input: update }, shared.makeContext()),
		]);
		expect(concurrent.every((result) => (result as { accepted: boolean }).accepted)).toBe(true);
		await expect(
			route("ingestProposal")({ input: update }, shared.makeContext()),
		).resolves.toMatchObject({
			accepted: false,
			status: "skipped",
		});
		expect(shared.target.get(proposal.id)).toEqual([...shared.claims.values()][0]?.record);
	});
	it("recovers a failed winner put from the canonical claim with stable timestamps", async () => {
		const shared = sharedRace(proposal);
		const update = { ...proposal, revision: 1, status: "needs_review" };
		shared.failNextPut();
		await expect(route("ingestProposal")({ input: update }, shared.makeContext())).rejects.toThrow(
			"RECORD_STORAGE_WRITE_FAILED",
		);
		const intended = structuredClone([...shared.claims.values()][0]?.record);
		await expect(
			route("ingestProposal")({ input: update }, shared.makeContext()),
		).resolves.toMatchObject({
			accepted: true,
		});
		expect(shared.target.get(proposal.id)).toEqual(intended);
		expect(shared.stats().targetPutCalls).toBe(2);
	});
	it("uses an atomic revision claim and retries the canonical record after a target write failure", async () => {
		const c = context({ ...proposal, revision: 0, status: "proposed" });
		const claims = c.ctx.storage.record_claims as {
			create: ReturnType<typeof vi.fn>;
			get: ReturnType<typeof vi.fn>;
		};
		const target = c.ctx.storage.proposals as { put: ReturnType<typeof vi.fn> };
		const first = target.put;
		first.mockRejectedValueOnce(new Error("transient"));
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, revision: 1, status: "needs_review" } },
				c.ctx,
			),
		).rejects.toThrow("RECORD_STORAGE_WRITE_FAILED");
		expect(claims.create).toHaveBeenCalledTimes(1);
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, revision: 1, status: "needs_review" } },
				c.ctx,
			),
		).resolves.toMatchObject({ accepted: true, revision: 1 });
		expect(target.put).toHaveBeenCalledTimes(2);
	});
	it("rejects a claim whose canonical record or digest is corrupted", async () => {
		const c = context({ ...proposal, revision: 0, status: "proposed" });
		const claims = c.ctx.storage.record_claims as {
			get: ReturnType<typeof vi.fn>;
			create: ReturnType<typeof vi.fn>;
		};
		claims.create.mockResolvedValue(false);
		claims.get.mockResolvedValue({
			version: 1,
			kind: "proposal",
			recordId: proposal.id,
			revision: 1,
			digest: `sha256:${"0".repeat(64)}`,
			record: { ...proposal, revision: 1, status: "needs_review" },
		});
		await expect(
			route("ingestProposal")(
				{ input: { ...proposal, revision: 1, status: "needs_review" } },
				c.ctx,
			),
		).rejects.toThrow("RECORD_CLAIM_CORRUPT");
	});
	it("fails closed for exact detail inputs", async () => {
		const detail = plugin.routes.recordDetail.handler as unknown as Handler;
		await expect(
			detail({ input: { kind: "proposal", id: "record-1", extra: true } }, {}),
		).rejects.toThrow("RECORD_DETAIL_INPUT_INVALID");
		const accessor = { kind: "proposal", id: "record-1" } as Record<string, unknown>;
		Object.defineProperty(accessor, "id", { enumerable: true, get: () => "record-1" });
		await expect(detail({ input: accessor }, {})).rejects.toThrow("RECORD_DETAIL_INPUT_INVALID");
	});
});
