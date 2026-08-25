import type { PluginDescriptor } from "emdash";

export function githubContentSyncPlugin(): PluginDescriptor {
	return {
		id: "sa-github-content-sync",
		version: "0.1.0",
		format: "standard",
		entrypoint: "@signal-alchemist/emdash-plugin-github-content-sync/sandbox",
		capabilities: ["content:write", "media:read", "media:write", "network:request"],
		allowedHosts: ["api.github.com", "raw.githubusercontent.com"],
		storage: {
			sync_receipts: {
				indexes: ["deliveryId", "commitSha", "planDigest", "state", "createdAt", "trustedActorId"],
			},
			sync_runs: {
				indexes: ["deliveryId", "commitSha", "sourcePath", "contentId", "status", "createdAt"],
			},
			sync_mappings: {
				indexes: [
					"repository",
					"branch",
					"sourcePath",
					"locale",
					"contentId",
					"status",
					"lastCommitSha",
				],
			},
			sync_attempts: {
				indexes: [
					"deliveryId",
					"repository",
					"commitSha",
					"planDigest",
					"state",
					"createdAt",
					"predecessorAttempt",
				],
			},
		},
		adminPages: [{ path: "/deliveries", label: "Content Sync", icon: "arrows-clockwise" }],
		adminWidgets: [{ id: "sync-status", title: "Content Sync", size: "third" }],
	};
}

export default githubContentSyncPlugin;
