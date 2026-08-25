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
	// oxlint-disable-next-line typescript/no-implied-eval -- this isolated test evaluates the generated wrapper source under test.
	return new Function("bridgeCall", `${source.slice(start, end + 1)}; return createContext;`)(bridgeCall)();
}

describe("workerd storage collection wrapper", () => {
	it("forwards media upload options", async () => {
		const calls: Array<[string, unknown]> = [];
		const context = extractContext(
			generatePluginWrapper({ id: "plugin", name: "Plugin", version: "1.0.0", capabilities: [], storage: [] } as never,
			{ backingServiceUrl: "http://bridge", authToken: "token", invokeToken: "invoke" }),
			(method, body) => { calls.push([method, body]); return Promise.resolve({ mediaId: "m" }); },
		);
		await context.media.upload("a.txt", "text/plain", new Uint8Array([1, 2]), { sha256: "a".repeat(64), alt: "A", deduplicate: true });
		expect(calls[0]).toEqual(["media/upload", expect.objectContaining({ options: { sha256: "a".repeat(64), alt: "A", deduplicate: true } })]);
	});

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
