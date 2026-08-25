import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import contentInsightsPlugin from "../../sa-content-insights/src/index.js";
import githubContentSyncPlugin from "../../sa-github-content-sync/src/index.js";
import { analyticsCollectorPlugin } from "../src/descriptor.js";
import { createPlugin } from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

async function readPackage(relativePath: string): Promise<Record<string, unknown>> {
	const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
	return JSON.parse(source) as Record<string, unknown>;
}

async function readManifest(relativePath: string): Promise<Record<string, unknown>> {
	const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
	const errors: Array<{ error: number; offset: number; length: number }> = [];
	const manifest = parse(source, errors) as Record<string, unknown>;
	expect(errors).toEqual([]);
	return manifest;
}

describe("marketing automation plugin package contracts", () => {
	it("publishes the native analytics descriptor and client entrypoints", async () => {
		const manifest = await readPackage("../package.json");
		const exportsMap = manifest.exports as Record<string, unknown>;

		expect(manifest.name).toBe("@signal-alchemist/emdash-plugin-analytics-collector");
		expect(manifest.main).toBe("src/index.ts");
		expect(exportsMap["."]).toBe("./src/index.ts");
		expect(exportsMap["./descriptor"]).toBe("./src/descriptor.ts");
		expect(exportsMap["./client"]).toBe("./src/client.ts");
		expect(manifest.peerDependencies).toEqual({ emdash: "workspace:>=0.15.0" });
	});

	it("exposes the native descriptor trust contract", () => {
		const descriptor = analyticsCollectorPlugin();
		expect(descriptor).toMatchObject({
			id: "sa-analytics-collector",
			version: "0.1.0",
			format: "native",
			entrypoint: "@signal-alchemist/emdash-plugin-analytics-collector",
		});
		expect(descriptor.options).toEqual({});
	});
	it("registers only the public bounded analytics route and least capability", () => {
		const plugin = createPlugin();
		expect(plugin.capabilities).toEqual(["hooks.page-fragments:register"]);
		expect(Object.keys(plugin.routes)).toEqual(["analytics/collect"]);
		expect(plugin.routes["analytics/collect"]).toMatchObject({
			public: true,
			bodyLimit: 64_000,
		});
		expect(Object.keys(plugin.storage ?? {})).toEqual([]);
	});

	it.each(["../../sa-content-insights/package.json", "../../sa-github-content-sync/package.json"])(
		"publishes a sandbox entrypoint for %s",
		async (relativePath) => {
			const manifest = await readPackage(relativePath);
			const exportsMap = manifest.exports as Record<string, unknown>;

			expect(exportsMap["."]).toBe("./src/index.ts");
			expect(exportsMap["./sandbox"]).toBe("./src/sandbox-entry.ts");
		},
	);

	it.each([
		[
			"../../sa-content-insights/emdash-plugin.jsonc",
			"sa-content-insights",
			["snapshots", "experiments", "proposals"],
		],
		[
			"../../sa-github-content-sync/emdash-plugin.jsonc",
			"sa-github-content-sync",
			["sync_runs", "sync_mappings", "sync_attempts"],
		],
	] as const)(
		"validates the authoring manifest for %s",
		async (relativePath, slug, collections) => {
			const manifest = await readManifest(relativePath);
			expect(manifest.slug).toBe(slug);
			expect(manifest.publisher).toBe("signal-alchemist.github.io");
			expect(manifest.publisher).not.toBe("did:plc:xyraubanwc5fwemkduw3upi6");
			expect(Object.keys(manifest.storage as Record<string, unknown>)).toEqual(collections);
			if (slug === "sa-github-content-sync") {
				expect(
					(manifest.storage as Record<string, { indexes: string[] }>).sync_attempts.indexes,
				).toEqual([
					"deliveryId",
					"repository",
					"commitSha",
					"planDigest",
					"state",
					"createdAt",
					"predecessorAttempt",
				]);
			}
		},
	);

	it.each([
		[
			contentInsightsPlugin,
			{
				id: "sa-content-insights",
				capabilities: ["content:read"],
				allowedHosts: [],
				storage: ["snapshots", "experiments", "proposals"],
			},
		],
		[
			githubContentSyncPlugin,
			{
				id: "sa-github-content-sync",
				capabilities: ["content:write", "media:write", "network:request"],
				allowedHosts: ["api.github.com", "raw.githubusercontent.com"],
				storage: ["sync_runs", "sync_mappings", "sync_attempts"],
			},
		],
	] as const)("exposes the standard descriptor trust contract", (factory, expected) => {
		const descriptor = typeof factory === "function" ? factory() : factory;
		expect(descriptor).toMatchObject({
			id: expected.id,
			version: "0.1.0",
			format: "standard",
			entrypoint: expect.stringMatching(/\/sandbox$/),
			capabilities: expected.capabilities,
			allowedHosts: expected.allowedHosts,
			adminPages: expect.any(Array),
			adminWidgets: expect.any(Array),
		});
		expect(Object.keys(descriptor.storage ?? {})).toEqual(expected.storage);
		if (expected.id === "sa-github-content-sync") {
			expect(descriptor.storage?.sync_attempts).toEqual({
				indexes: [
					"deliveryId",
					"repository",
					"commitSha",
					"planDigest",
					"state",
					"createdAt",
					"predecessorAttempt",
				],
			});
		}
	});

	it.each([
		["../../sa-content-insights/emdash-plugin.jsonc", contentInsightsPlugin],
		["../../sa-github-content-sync/emdash-plugin.jsonc", githubContentSyncPlugin],
	] as const)(
		"keeps manifest and runtime storage descriptors aligned for %s",
		async (relativePath, factory) => {
			const manifest = await readManifest(relativePath);
			const descriptor = factory();

			expect(descriptor.storage).toEqual(manifest.storage);
		},
	);

	it("keeps the native package source entrypoints present", async () => {
		await expect(readFile(`${packageRoot}/src/index.ts`, "utf8")).resolves.toContain(
			"analyticsCollectorPlugin",
		);
		await expect(readFile(`${packageRoot}/src/client.ts`, "utf8")).resolves.toContain(
			"createAnalyticsClient",
		);
	});
});
