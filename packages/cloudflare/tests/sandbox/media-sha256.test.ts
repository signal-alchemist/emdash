import { describe, expect, it } from "vitest";

import { mediaSha256 } from "../../src/sandbox/media-sha256.js";

describe("sandbox media SHA-256", () => {
	it("returns the canonical persisted digest", async () => {
		expect(await mediaSha256(new TextEncoder().encode("receipt-media").buffer)).toBe(
			"cafa2e9a38ac0b5a7abbf146d6e8bf6a0b39c27bd2a47055579eff2dcf8fac9c",
		);
	});
});
