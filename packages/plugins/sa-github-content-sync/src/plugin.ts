import type { SandboxedPlugin } from "emdash/plugin";

type StagedSync = {
  deliveryId: string;
  repository: string;
  branch: string;
  commitSha: string;
  sourcePath: string;
  operation: "upsert" | "rename" | "unpublish" | "delete";
  contentId?: string;
  expectedRevision?: string;
};

function readStagedSync(input: unknown): StagedSync {
  if (!input || typeof input !== "object") {
    throw new Error("A synchronization command is required");
  }

  const value = input as Record<string, unknown>;
  const required = ["deliveryId", "repository", "branch", "commitSha", "sourcePath", "operation"] as const;

  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`Invalid or missing ${key}`);
    }
  }

  const operation = value.operation;
  if (operation !== "upsert" && operation !== "rename" && operation !== "unpublish" && operation !== "delete") {
    throw new Error("Unsupported synchronization operation");
  }

  return {
    deliveryId: value.deliveryId as string,
    repository: value.repository as string,
    branch: value.branch as string,
    commitSha: value.commitSha as string,
    sourcePath: value.sourcePath as string,
    operation,
    contentId: typeof value.contentId === "string" ? value.contentId : undefined,
    expectedRevision: typeof value.expectedRevision === "string" ? value.expectedRevision : undefined,
  };
}

export default {
  routes: {
    health: {
      handler: async () => ({
        ok: true,
        plugin: "sa-github-content-sync",
        phase: "foundation",
      }),
    },

    stage: {
      handler: async (routeCtx, ctx) => {
        const command = readStagedSync(routeCtx.input);
        const existing = await ctx.storage.syncRuns.query({
          where: { deliveryId: command.deliveryId },
          limit: 1,
        });

        if (existing.items.length > 0) {
          return {
            accepted: false,
            reason: "duplicate-delivery",
            deliveryId: command.deliveryId,
          };
        }

        const createdAt = new Date().toISOString();
        const runId = `${command.deliveryId}:${command.commitSha}:${command.sourcePath}`;

        await ctx.storage.syncRuns.put(runId, {
          ...command,
          status: "accepted",
          createdAt,
        });

        ctx.log.info("Synchronization command staged", {
          deliveryId: command.deliveryId,
          commitSha: command.commitSha,
          sourcePath: command.sourcePath,
          operation: command.operation,
        });

        // The implementation PR will verify the GitHub HMAC before staging,
        // fetch and validate the source catalog, upload hashed media, then call
        // ctx.content with expected-revision conflict handling.
        return { accepted: true, runId, createdAt };
      },
    },

    recent: {
      handler: async (_routeCtx, ctx) => {
        const result = await ctx.storage.syncRuns.query({
          orderBy: { createdAt: "desc" },
          limit: 20,
        });

        return { runs: result.items };
      },
    },
  },
} satisfies SandboxedPlugin;
