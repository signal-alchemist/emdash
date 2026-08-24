import { definePlugin } from "emdash";

import type { AnalyticsCollectorOptions } from "./descriptor.js";
import { analyticsPageFragments } from "./fragments.js";

export { analyticsCollectorPlugin } from "./descriptor.js";
export type { AnalyticsCollectorOptions } from "./descriptor.js";

export { analyticsPageFragments } from "./fragments.js";
export type { AnalyticsPageContext } from "./fragments.js";

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
	});
}

export default createPlugin;
