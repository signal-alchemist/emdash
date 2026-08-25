import { describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("emdash", () => ({
	PluginStorageRepository: vi.fn(function (this: { create: typeof create }) {
		this.create = create;
	}),
	ContentRepository: vi.fn(),
	createHttpAccess: vi.fn(),
	createUnrestrictedHttpAccess: vi.fn(),
	createSandboxRouteErrorEnvelope: vi.fn(),
	resolveContentCreateLocale: vi.fn(),
}));

import { createBridgeHandler } from "../src/sandbox/bridge-handler.js";

describe("workerd storage/create bridge dispatch", () => {
	it("returns the repository boolean for both insert outcomes", async () => {
		const handler = createBridgeHandler({
			db: {} as never,
			pluginId: "plugin",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections: ["items"],
			storageConfig: { items: {} },
			emailSend: () => null,
		} as never);
		for (const result of [true, false]) {
			create.mockResolvedValueOnce(result);
			const response = await handler(new Request("https://bridge.test/storage/create", {
				method: "POST",
				body: JSON.stringify({ collection: "items", id: "one", data: { ok: true } }),
			}));
			expect((await response.json() as { result: boolean }).result).toBe(result);
		}
		expect(create).toHaveBeenCalledTimes(2);
		const rejected = await handler(new Request("https://bridge.test/storage/create", {
			method: "POST",
			body: JSON.stringify({ collection: "undeclared", id: "one", data: {} }),
		}));
		expect(rejected.status).toBe(500);
		expect(await rejected.text()).toContain("Storage collection not declared: undeclared");
		expect(create).toHaveBeenCalledTimes(2);
	});
});
