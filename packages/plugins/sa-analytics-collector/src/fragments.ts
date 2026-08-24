import type { PublicPageContext } from "emdash";

import { createAnalyticsClientBootstrap } from "./client.js";
import type { AnalyticsCollectorOptions } from "./descriptor.js";

export type AnalyticsPageContext = PublicPageContext;
export interface AnalyticsFragment {
	kind: "inline-script";
	placement: "body:end";
	key: string;
	code: string;
}
function publicEndpoint(endpoint: string | undefined): string {
	const candidate = endpoint ?? "/api/analytics";
	if (
		candidate.startsWith("/") &&
		!candidate.startsWith("//") &&
		!candidate.includes("?") &&
		!candidate.includes("#")
	)
		return candidate;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
			return "/api/analytics";
		return "/api/analytics";
	} catch {
		return "/api/analytics";
	}
}

export function analyticsPageFragments(
	page: AnalyticsPageContext,
	options: AnalyticsCollectorOptions,
): AnalyticsFragment[] {
	if (
		options.enabled === false ||
		page.kind !== "content" ||
		page.path.startsWith("/_emdash/") ||
		page.path.startsWith("/admin") ||
		page.pageType === "draft"
	)
		return [];
	try {
		const url = new URL(page.url, "https://public.invalid");
		if (
			url.searchParams.has("preview") ||
			url.searchParams.has("draft") ||
			url.searchParams.get("mode") === "preview"
		)
			return [];
	} catch {
		return [];
	}
	const config = JSON.stringify({
		version: 1,
		enabled: options.enabled ?? true,
		endpoint: publicEndpoint(options.endpoint),
		contentId: page.content?.id,
	}).replace(/</g, "\\u003c");
	return [
		{
			kind: "inline-script",
			placement: "body:end",
			key: "sa-analytics-collector",
			code: `window.__EMDASH_ANALYTICS_CONFIG__=${config};${createAnalyticsClientBootstrap(config)}`,
		},
	];
}
