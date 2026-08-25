/**
 * Integration tests for route auth metadata on config-declared sandboxed plugins.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";

const BODY_LIMIT = 64_000;
const PLUGIN_ID = "demo";
const invokeRoute = vi.fn(async (_routeName: string, body: unknown) => body);

function jsonBodyWithByteLength(byteLength: number): string {
	const prefix = '{"payload":"';
	const suffix = '"}';
	const body = `${prefix}${"x".repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
	expect(new TextEncoder().encode(body)).toHaveLength(byteLength);
	return body;
}

function createHarness(): {
	deps: RuntimeDependencies;
	invokeRoute: ReturnType<typeof vi.fn>;
} {
	const entrypoint = `test-sandboxed-route-meta-${randomUUID()}`;
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn().mockResolvedValue({ invokeHook: vi.fn(), invokeRoute }),
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(),
	};
	const deps: RuntimeDependencies = {
		config: { database: { entrypoint, config: {}, type: "sqlite" } },
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: [
			{
				id: PLUGIN_ID,
				version: "1.0.0",
				options: {},
				code: "",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				routes: [
					{ name: "ping", public: true },
					{ name: "ingest", public: true, bodyLimit: BODY_LIMIT },
				],
			},
		],
		// eslint-disable-next-line typescript/no-explicit-any -- test fake matches the SandboxRunner shape create.test.ts already uses
		createSandboxRunner: (() => runner) as any,
	};
	return { deps, invokeRoute };
}

async function createRuntimeHarness() {
	const harness = createHarness();
	const runtime = await EmDashRuntime.create(harness.deps);
	return { ...harness, runtime };
}

async function invokeIngest(
	runtime: EmDashRuntime,
	pluginId: string,
	body: BodyInit,
	headers?: HeadersInit,
) {
	return runtime.handlePluginApiRoute(
		pluginId,
		"POST",
		"/ingest",
		new Request("https://site.test/_emdash/api/plugins/demo/ingest", {
			method: "POST",
			body,
			headers,
			duplex: body instanceof ReadableStream ? "half" : undefined,
		}),
	);
}

describe("EmDashRuntime — config-declared sandboxed plugin route metadata", () => {
	beforeEach(() => {
		invokeRoute.mockClear();
	});

	it("honors public: true declared in the sandboxed entry's routes", async () => {
		const { runtime } = await createRuntimeHarness();
		try {
			expect(runtime.getPluginRouteMeta(PLUGIN_ID, "ping")).toMatchObject({ public: true });
		} finally {
			await runtime.stopCron();
		}
	});

	it("still falls back to non-public for a route the entry didn't declare", async () => {
		const { runtime } = await createRuntimeHarness();
		try {
			expect(runtime.getPluginRouteMeta(PLUGIN_ID, "other")).toMatchObject({ public: false });
		} finally {
			await runtime.stopCron();
		}
	});

	it("propagates the manifest body limit into sandbox route metadata", async () => {
		const { runtime } = await createRuntimeHarness();
		try {
			expect(runtime.getPluginRouteMeta(PLUGIN_ID, "ingest")).toEqual({
				public: true,
				bodyLimit: BODY_LIMIT,
			});
		} finally {
			await runtime.stopCron();
		}
	});

	it("accepts valid JSON exactly at the 64 KB sandbox route limit", async () => {
		const { runtime } = await createRuntimeHarness();
		try {
			const result = await invokeIngest(runtime, PLUGIN_ID, jsonBodyWithByteLength(BODY_LIMIT));
			expect(result.success).toBe(true);
			expect(invokeRoute).toHaveBeenCalledOnce();
			expect(invokeRoute.mock.calls[0]?.[0]).toBe("ingest");
		} finally {
			await runtime.stopCron();
		}
	});

	it("rejects a body one byte over the 64 KB limit before sandbox invocation", async () => {
		const { runtime } = await createRuntimeHarness();
		try {
			const result = await invokeIngest(runtime, PLUGIN_ID, jsonBodyWithByteLength(BODY_LIMIT + 1));
			expect(result).toMatchObject({
				success: false,
				status: 413,
				error: { code: "PLUGIN_BODY_INVALID" },
			});
			expect(invokeRoute).not.toHaveBeenCalled();
		} finally {
			await runtime.stopCron();
		}
	});

	it("rejects a false Content-Length before sandbox invocation", async () => {
		const { runtime } = await createRuntimeHarness();
		try {
			const result = await invokeIngest(runtime, PLUGIN_ID, "{}", { "content-length": "1" });
			expect(result).toMatchObject({ success: false, status: 413 });
			expect(invokeRoute).not.toHaveBeenCalled();
		} finally {
			await runtime.stopCron();
		}
	});

	it("rejects malformed JSON before sandbox invocation", async () => {
		const { runtime } = await createRuntimeHarness();
		try {
			const result = await invokeIngest(runtime, PLUGIN_ID, "{");
			expect(result).toMatchObject({ success: false, status: 413 });
			expect(invokeRoute).not.toHaveBeenCalled();
		} finally {
			await runtime.stopCron();
		}
	});

	it("cancels an oversized chunked stream before sandbox invocation", async () => {
		const { runtime } = await createRuntimeHarness();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(BODY_LIMIT));
				controller.enqueue(new Uint8Array([1]));
			},
			cancel() {
				cancelled = true;
			},
		});
		try {
			const result = await invokeIngest(runtime, PLUGIN_ID, stream);
			expect(result).toMatchObject({ success: false, status: 413 });
			expect(cancelled).toBe(true);
			expect(invokeRoute).not.toHaveBeenCalled();
		} finally {
			await runtime.stopCron();
		}
	});
});
