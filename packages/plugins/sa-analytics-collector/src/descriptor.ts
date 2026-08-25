import type { PluginDescriptor } from "emdash";

export interface AnalyticsCollectorOptions {
	enabled?: boolean;
	endpoint?: string;
	/** Host-provided durable controls; analytics batches are never plugin storage. */
	ingress?: import("./ingress.js").AnalyticsIngressOptions;
}

export function analyticsCollectorPlugin(
	options: AnalyticsCollectorOptions = {},
): PluginDescriptor {
	return {
		id: "sa-analytics-collector",
		version: "0.1.0",
		format: "native",
		entrypoint: "@signal-alchemist/emdash-plugin-analytics-collector",
		options: { ...options },
	};
}
