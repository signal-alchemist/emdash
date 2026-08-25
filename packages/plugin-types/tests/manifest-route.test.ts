import { describe, expect, it } from "vitest";

import { normalizeManifestRoute, pluginManifestSchema } from "../src/index.js";

function manifest(routes: unknown[]) {
	return {
		id: "example-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes,
		admin: {},
	};
}

describe("manifest route body limits", () => {
	it("parses a positive integer body limit", () => {
		const result = pluginManifestSchema.safeParse(
			manifest([{ name: "ingest", public: true, bodyLimit: 64_000 }]),
		);
		expect(result.success).toBe(true);
	});

	it.each([0, -1, 1.5])("rejects invalid body limit %s", (bodyLimit) => {
		const result = pluginManifestSchema.safeParse(manifest([{ name: "ingest", bodyLimit }]));
		expect(result.success).toBe(false);
	});

	it("preserves body limits while normalizing structured routes", () => {
		expect(
			normalizeManifestRoute({
				name: "ingest",
				public: false,
				permission: "content:read",
				bodyLimit: 64_000,
			}),
		).toEqual({
			name: "ingest",
			public: false,
			permission: "content:read",
			bodyLimit: 64_000,
		});
	});
});
