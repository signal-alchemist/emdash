import { definePlugin } from "emdash";

import type { AnalyticsCollectorOptions } from "./descriptor.js";
import { analyticsPageFragments } from "./fragments.js";
import { ingestAnalytics, ANALYTICS_BODY_LIMIT, type AnalyticsIngressOptions } from "./ingress.js";

export { analyticsCollectorPlugin } from "./descriptor.js";
export type { AnalyticsCollectorOptions } from "./descriptor.js";

export { analyticsPageFragments } from "./fragments.js";
export type { AnalyticsPageContext } from "./fragments.js";
export { ingestAnalytics, ANALYTICS_BODY_LIMIT, createAnalyticsForwarder } from "./ingress.js";
export type {
	AnalyticsIngressOptions,
	DurableLimiter,
	DurableReservation,
	AnalyticsForwarder,
} from "./ingress.js";

export function createPlugin(options: AnalyticsCollectorOptions = {}) {
	return definePlugin({
		id: "sa-analytics-collector",
		version: "0.1.0",
		capabilities: ["hooks.page-fragments:register"],
		hooks: {
			"page:fragments": {
				handler: ({ page }) => analyticsPageFragments(page, options),
			},
		},
		routes: {
			"analytics/collect": {
				public: true,
				bodyLimit: ANALYTICS_BODY_LIMIT,
				handler: (ctx) =>
					ingestAnalytics(ctx, options.ingress as AnalyticsIngressOptions | undefined),
			},
		},
	});
}

export default createPlugin;
