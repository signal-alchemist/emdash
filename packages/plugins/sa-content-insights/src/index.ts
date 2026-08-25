import type { PluginDescriptor } from "emdash";

export function contentInsightsPlugin(): PluginDescriptor {
	return {
		id: "sa-content-insights",
		version: "0.1.0",
		format: "standard",
		entrypoint: "@signal-alchemist/emdash-plugin-content-insights/sandbox",
		capabilities: ["content:read"],
		allowedHosts: [],
		storage: {
			snapshots: { indexes: ["targetKey", "generatedAt", "snapshotId"] },
			experiments: { indexes: ["targetKey", "status", "updatedAt"] },
			proposals: { indexes: ["targetKey", "status", "createdAt"] },
			record_claims: { indexes: ["kind", "recordId", "revision", "digest"] },
		},
		adminPages: [{ path: "/insights", label: "Content Insights", icon: "chart-line-up" }],
		adminWidgets: [{ id: "insight-summary", title: "Content Insights", size: "half" }],
	};
}

export default contentInsightsPlugin;
