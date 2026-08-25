import { describe, expect, it } from "vitest";
import { generatePluginWrapper } from "../src/sandbox/wrapper.js";

function extractContext(source: string, bridgeCall: (method: string, body: unknown) => unknown) {
	const marker = "function createContext() {";
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
	return new Function("bridgeCall", `${source.slice(start, end + 1)}; return createContext;`)(bridgeCall)();
}

describe("workerd storage collection wrapper", () => {
	it("sends storage/create and preserves true and false", async () => {
		const calls: Array<[string, unknown]> = [];
		let result = true;
		const context = extractContext(
			generatePluginWrapper(
				{ id: "plugin", name: "Plugin", version: "1.0.0", capabilities: [], storage: [] } as never,
				{ backingServiceUrl: "http://bridge", authToken: "token", invokeToken: "invoke" },
			),
			(method, body) => {
				calls.push([method, body]);
				return Promise.resolve(result);
			},
		);
		expect(await context.storage.items.create("id", { value: 1 })).toBe(true);
		result = false;
		expect(await context.storage.items.create("id", { value: 1 })).toBe(false);
		expect(calls).toEqual([
			["storage/create", { collection: "items", id: "id", data: { value: 1 } }],
			["storage/create", { collection: "items", id: "id", data: { value: 1 } }],
		]);
	});
});
