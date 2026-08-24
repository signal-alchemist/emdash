import type { SandboxedPlugin } from "emdash/plugin";

type StoredRecord = Record<string, unknown> & {
	id: string;
	targetKey: string;
};

function readRecord(input: unknown, kind: "snapshot" | "proposal" | "experiment"): StoredRecord {
	if (!input || typeof input !== "object") {
		throw new Error(`${kind} payload is required`);
	}

	const value = input as Record<string, unknown>;
	if (typeof value.id !== "string" || value.id.length === 0) {
		throw new Error(`${kind}.id is required`);
	}
	if (typeof value.targetKey !== "string" || value.targetKey.length === 0) {
		throw new Error(`${kind}.targetKey is required`);
	}

	return value as StoredRecord;
}

export default {
	routes: {
		health: {
			handler: async () => ({
				ok: true,
				plugin: "sa-content-insights",
				phase: "foundation",
			}),
		},
		ingestSnapshot: {
			handler: async (routeCtx, ctx) => {
				const snapshot = readRecord(routeCtx.input, "snapshot");
				const generatedAt =
					typeof snapshot.generatedAt === "string"
						? snapshot.generatedAt
						: new Date().toISOString();
				await ctx.storage.snapshots.put(snapshot.id, { ...snapshot, generatedAt });
				return { accepted: true, snapshotId: snapshot.id, generatedAt };
			},
		},
		ingestProposal: {
			handler: async (routeCtx, ctx) => {
				const proposal = readRecord(routeCtx.input, "proposal");
				const createdAt =
					typeof proposal.createdAt === "string"
						? proposal.createdAt
						: new Date().toISOString();
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
