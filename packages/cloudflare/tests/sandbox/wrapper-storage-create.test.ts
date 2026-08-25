import { describe, expect, it, vi } from "vitest";

vi.mock("emdash", () => ({
	normalizeCapabilities: (values: string[]) => values,
}));
import { generatePluginWrapper } from "../../src/sandbox/wrapper.js";

function extractContext(source: string, env: unknown) {
	const marker = "function createContext(env) {";
	const start = source.indexOf(marker);
	const open = source.indexOf("{", start);
	let depth = 0;
	let end = -1;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		if (source[i] === "}" && --depth === 0) {
			end = i;
			break;
		}
	}
	if (start < 0 || end < 0) throw new Error("createContext not found");
	// eslint-disable-next-line no-implied-eval
	const factory = new Function(`${source.slice(start, end + 1)}; return createContext;`);
	return factory()(env);
}

describe("Cloudflare generated storage wrapper", () => {
	it("forwards storageCreate and preserves true/false", async () => {
		const calls: Array<[string, string, unknown]> = [];
		let result = true;
		const ctx = extractContext(
			generatePluginWrapper({
				id: "plugin",
				name: "Plugin",
				version: "1.0.0",
				capabilities: [],
				storage: { items: {} },
			} as never),
			{
				BRIDGE: {
					storageCreate: (collection: string, id: string, data: unknown) => {
						calls.push([collection, id, data]);
						return Promise.resolve(result);
					},
				},
			},
		);
		expect(await ctx.storage.items.create("one", { ok: true })).toBe(true);
		result = false;
		expect(await ctx.storage.items.create("one", { ok: true })).toBe(false);
		expect(calls).toEqual([
			["items", "one", { ok: true }],
			["items", "one", { ok: true }],
		]);
	});
});
