import { describe, expect, it } from "vitest";

import { BoundedBodyError, readBoundedJson } from "../../src/plugins/bounded-body.js";
import { parseRouteInput } from "../../src/plugins/routes.js";

const request = (body: BodyInit | null, headers: Record<string, string> = {}) =>
	new Request("https://site.test/_emdash/api/plugins/x/collect", { method: "POST", body, headers });

describe("bounded plugin route bodies", () => {
	it("rejects compression, lying lengths, malformed UTF-8, and stream overflow", async () => {
		await expect(
			readBoundedJson(request("{}", { "content-encoding": "br" }), 10),
		).rejects.toBeInstanceOf(BoundedBodyError);
		await expect(
			readBoundedJson(request("{}", { "content-length": "999" }), 10),
		).rejects.toBeInstanceOf(BoundedBodyError);
		await expect(
			readBoundedJson(
				request(new Uint8Array([0xc3, 0x28]), { "content-type": "application/json" }),
				10,
			),
		).rejects.toBeInstanceOf(BoundedBodyError);
		await expect(readBoundedJson(request("12345678901"), 10)).rejects.toBeInstanceOf(
			BoundedBodyError,
		);
	});
	it("accepts identity encoded JSON at the exact cap", async () => {
		await expect(
			readBoundedJson(request("{}", { "content-encoding": "identity" }), 2),
		).resolves.toEqual({});
	});
	it("rejects invalid, unsafe, and over-limit declared lengths", async () => {
		for (const length of ["-1", "1.5", "999999999999999999999999"]) {
			await expect(
				readBoundedJson(request("{}", { "content-length": length }), 10),
			).rejects.toBeInstanceOf(BoundedBodyError);
		}
	});
	it("rejects absent bodies, malformed JSON, and malformed UTF-8", async () => {
		await expect(readBoundedJson(request(null), 10)).rejects.toBeInstanceOf(BoundedBodyError);
		await expect(readBoundedJson(request("{"), 10)).rejects.toBeInstanceOf(BoundedBodyError);
		await expect(readBoundedJson(request(new Uint8Array([0xc3, 0x28])), 10)).rejects.toBeInstanceOf(
			BoundedBodyError,
		);
	});
	it("accepts identity encoding case-insensitively and leaves non-body methods alone", async () => {
		await expect(
			readBoundedJson(request("{}", { "content-encoding": "IDENTITY" }), 2),
		).resolves.toEqual({});
		const get = new Request("https://site.test/", { method: "GET" });
		await expect(readBoundedJson(get, 2)).resolves.toBeUndefined();
	});
	it("production parser delegates bounded requests and preserves typed errors", async () => {
		await expect(parseRouteInput(request('{"ok":true}'), 11)).resolves.toEqual({ ok: true });
		await expect(
			parseRouteInput(request("{}", { "content-length": "1" }), 10),
		).rejects.toBeInstanceOf(BoundedBodyError);
	});
	it("rejects a content-length smaller than the received body", async () => {
		const smallerLie = new Request("https://site.test/", {
			method: "POST",
			body: "{}",
			headers: { "content-length": "1" },
		});
		await expect(readBoundedJson(smallerLie, 10)).rejects.toBeInstanceOf(BoundedBodyError);
	});
	it("maps an errored stream to the typed bounded error and cancels it", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([123]));
				controller.error(new Error("boom"));
			},
		});
		await expect(
			readBoundedJson(
				new Request("https://site.test/", { method: "POST", body: stream, duplex: "half" }),
				10,
			),
		).rejects.toBeInstanceOf(BoundedBodyError);
	});
});
