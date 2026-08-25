import { describe, expect, it, vi } from "vitest";

import {
	ATTEMPT_STATES,
	createAttempt,
	cleanupAttempts,
	detailAttempt,
	listAttempts,
	readAttempt,
	retryAttempt,
	retryAttemptWork,
	transitionAttempt,
} from "../src/audit.js";

const base = {
	attemptId: "delivery-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	deliveryId: "delivery-1",
	repository: "signal-alchemist/site",
	branch: "refs/heads/main",
	commitSha: "a".repeat(40),
	actorId: "7",
	pullRequestNumber: 1,
	filesUrl: "https://api.github.com/repos/signal-alchemist/site/pulls/1/files",
};

function context() {
	const records = new Map<string, unknown>();
	return {
		records,
		storage: {
			sync_attempts: {
				get: vi.fn(async (id: string) => (records.has(id) ? { id, data: records.get(id) } : null)),
				create: vi.fn(async (id: string, data: unknown) => {
					if (records.has(id)) return false;
					records.set(id, structuredClone(data));
					return true;
				}),
				put: vi.fn(async (id: string, data: unknown) => {
					records.set(id, structuredClone(data));
				}),
				delete: vi.fn(async (id: string) => records.delete(id)),
				query: vi.fn(async () => ({
					items: Array.from(records.entries(), ([id, data]) => ({ id, data })),
					hasMore: false,
				})),
			},
		},
	};
}

describe("sync attempt audit state machine", () => {
	it("exercises every allowed and forbidden transition edge against transitionAttempt", async () => {
		const allowed: Record<(typeof ATTEMPT_STATES)[number], string[]> = {
			accepted: ["validating", "failed", "skipped"],
			validating: ["planned", "failed"],
			planned: ["applying", "skipped", "conflict", "failed"],
			applying: ["succeeded", "conflict", "failed"],
			succeeded: [],
			skipped: [],
			conflict: ["validating"],
			failed: ["validating"],
		};
		const path: Record<string, string[]> = {
			accepted: [],
			validating: ["validating"],
			planned: ["validating", "planned"],
			applying: ["validating", "planned", "applying"],
			succeeded: ["validating", "planned", "applying", "succeeded"],
			skipped: ["skipped"],
			conflict: ["validating", "planned", "conflict"],
			failed: ["failed"],
		};
		for (const state of ATTEMPT_STATES) {
			for (const next of ATTEMPT_STATES) {
				const ctx = context();
				const id = `${base.attemptId}:matrix:${state}:${next}`;
				await createAttempt(ctx, { ...base, attemptId: id });
				for (const step of path[state] ?? []) {
					const patch =
						step === "planned"
							? { planDigest: "b".repeat(64) }
							: step === "failed"
								? { errorCode: "ATTEMPT_FAILED" }
								: step === "succeeded"
									? { contentIds: ["content-launch"] }
									: {};
					await transitionAttempt(ctx, id, step as never, patch);
				}
				if (allowed[state].includes(next))
					await expect(
						transitionAttempt(
							ctx,
							id,
							next,
							next === "planned"
								? { planDigest: "c".repeat(64) }
								: next === "failed"
									? { errorCode: "ATTEMPT_FAILED" }
									: next === "succeeded"
										? { contentIds: ["content-launch"] }
										: {},
						),
					).resolves.toMatchObject({ state: next });
				else
					await expect(transitionAttempt(ctx, id, next)).rejects.toThrow(
						"ATTEMPT_INVALID_TRANSITION",
					);
			}
		}
		expect(Object.values(allowed).flat()).toHaveLength(14);
	});
	it("enforces the complete bounded transition matrix and terminal states", async () => {
		const ctx = context();
		await createAttempt(ctx, base);
		let state = await transitionAttempt(ctx, base.attemptId, "validating");
		state = await transitionAttempt(ctx, base.attemptId, "planned", { planDigest: "b".repeat(64) });
		state = await transitionAttempt(ctx, base.attemptId, "applying");
		state = await transitionAttempt(ctx, base.attemptId, "succeeded", {
			revision: "rev-1",
			contentIds: ["content-launch"],
			mediaIds: ["media-1"],
		});
		expect(state.state).toBe("succeeded");
		await expect(transitionAttempt(ctx, base.attemptId, "failed")).rejects.toThrow(
			"ATTEMPT_INVALID_TRANSITION",
		);
		expect(ATTEMPT_STATES).toEqual([
			"accepted",
			"validating",
			"planned",
			"applying",
			"succeeded",
			"skipped",
			"conflict",
			"failed",
		]);
	});

	it("rejects unbounded or raw attempt records and bounds pagination", async () => {
		const ctx = context();
		const created = await createAttempt(ctx, base);
		ctx.storage.sync_attempts.query = vi.fn(async () => ({
			items: Array.from(ctx.records.entries(), ([id, data]) => ({ id, data })),
			cursor: "next",
			hasMore: true,
		}));
		const page = await listAttempts(ctx, { limit: 999 });
		expect(page.items).toHaveLength(1);
		expect(page.cursor).toBe("next");
		expect(readAttempt({ ...created, warnings: ["x".repeat(201)] })).toBeNull();
		expect(readAttempt({ ...created, warnings: ["provider secret"] })).toBeNull();
		expect(readAttempt({ ...created, extra: "raw" })).toBeNull();
		expect(readAttempt(Object.assign(Object.create({ raw: true }), created))).toBeNull();
	});

	it("covers failed/conflict/skipped transitions and rejects identity mutation", async () => {
		for (const terminal of ["skipped", "failed"] as const) {
			const ctx = context();
			await createAttempt(ctx, { ...base, attemptId: `${base.attemptId}-${terminal}` });
			await transitionAttempt(ctx, `${base.attemptId}-${terminal}`, terminal, {
				errorCode: terminal === "failed" ? "PLAN_INVALID" : undefined,
			});
			if (terminal === "skipped")
				await expect(
					transitionAttempt(ctx, `${base.attemptId}-${terminal}`, "validating"),
				).rejects.toThrow("ATTEMPT_INVALID_TRANSITION");
			else await transitionAttempt(ctx, `${base.attemptId}-${terminal}`, "validating");
		}
		const ctx = context();
		await createAttempt(ctx, base);
		await expect(
			transitionAttempt(ctx, base.attemptId, "validating", { repository: "evil/repo" } as never),
		).rejects.toThrow("ATTEMPT_IDENTITY_IMMUTABLE");
	});

	it("chains retry counts and preserves canonical timestamps and safe projections", async () => {
		const ctx = context();
		const first = await createAttempt(ctx, base);
		const second = await createAttempt(ctx, {
			...base,
			attemptId: `${base.attemptId}:retry-1`,
			predecessorAttempt: first.attemptId,
			retryCount: first.retryCount + 1,
		});
		expect(second.retryCount).toBe(1);
		expect((await detailAttempt(ctx, second.attemptId)).history).toHaveLength(1);
		await expect(cleanupAttempts(ctx, { before: "not-a-date" })).rejects.toThrow(
			"ATTEMPT_CUTOFF_INVALID",
		);
	});

	it("preserves active records during bounded retention cleanup", async () => {
		const ctx = context();
		const created = await createAttempt(ctx, base);
		ctx.records.set(base.attemptId, {
			...created,
			state: "applying",
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
			history: [
				{ state: "accepted", at: created.createdAt },
				{ state: "applying", at: created.updatedAt },
			],
		});
		expect(await cleanupAttempts(ctx, { before: "2026-01-01T00:00:00.000Z" })).toBe(0);
		expect(ctx.records.has(base.attemptId)).toBe(true);
	});

	it("fails closed when retry policy or trusted review actor is absent", async () => {
		const ctx = context();
		await createAttempt(ctx, base);
		await transitionAttempt(ctx, base.attemptId, "validating");
		await transitionAttempt(ctx, base.attemptId, "failed", { errorCode: "ATTEMPT_FAILED" });
		await expect(
			retryAttempt(ctx, { attemptId: base.attemptId, idempotencyKey: "retry-1" }),
		).rejects.toThrow("ATTEMPT_POLICY_INVALID");
	});

	it("fences an expired owner lease before transition", async () => {
		const ctx = context();
		const created = await createAttempt(ctx, { ...base, reservationToken: "owner-a" });
		ctx.records.set(base.attemptId, {
			...created,
			leaseExpiresAt: "2020-01-01T00:00:00.000Z",
		});
		await expect(
			transitionAttempt(ctx, base.attemptId, "validating", {}, "owner-a"),
		).rejects.toThrow("ATTEMPT_LEASE_FENCED");
	});

	it("converges two independent contexts on one atomic reservation", async () => {
		const records = new Map<string, unknown>();
		const storage = {
			sync_attempts: {
				get: async (id: string) => (records.has(id) ? { id, data: records.get(id) } : null),
				create: async (id: string, data: unknown) => {
					if (records.has(id)) return false;
					records.set(id, structuredClone(data));
					return true;
				},
				put: async (id: string, data: unknown) => {
					records.set(id, structuredClone(data));
				},
				delete: async (id: string) => records.delete(id),
				query: async () => ({ items: [], hasMore: false }),
			},
		};
		const first = await createAttempt({ storage } as never, {
			...base,
			reservationToken: "owner-a",
		});
		const second = await createAttempt({ storage } as never, {
			...base,
			reservationToken: "owner-b",
		});
		expect(first.reservationToken).toBe(second.reservationToken);
		expect(records.size).toBe(1);
	});

	it("runs one worker for two independent contexts and replays failed terminal outcome", async () => {
		const records = new Map<string, unknown>();
		const collection = {
			get: async (id: string) => (records.has(id) ? { id, data: records.get(id) } : null),
			create: async (id: string, data: unknown) => {
				if (records.has(id)) return false;
				records.set(id, structuredClone(data));
				return true;
			},
			put: async (id: string, data: unknown) => records.set(id, structuredClone(data)),
			delete: async (id: string) => records.delete(id),
			query: async () => ({ items: [], hasMore: false }),
		};
		const first = {
			storage: { sync_attempts: collection },
			syncPolicy: { repository: base.repository, branch: base.branch },
		} as never;
		const second = {
			storage: { sync_attempts: collection },
			syncPolicy: { repository: base.repository, branch: base.branch },
		} as never;
		await createAttempt(first, base);
		await transitionAttempt(first, base.attemptId, "validating");
		await transitionAttempt(first, base.attemptId, "failed", { errorCode: "ATTEMPT_FAILED" });
		const results = await Promise.all([
			retryAttemptWork(first, { attemptId: base.attemptId, idempotencyKey: "same-key" }),
			retryAttemptWork(second, { attemptId: base.attemptId, idempotencyKey: "same-key" }),
		]);
		expect(results[0]!.attempt.state).toBe("failed");
		expect(results[1]!.attempt.state).toBe("failed");
		expect(records.has(`${base.attemptId}:same-key`)).toBe(true);
		expect(
			[...records.keys()].filter((id) => id.startsWith(`${base.attemptId}:same-key:g`)).length,
		).toBe(0);
	});

	it("fails closed for an expired applying generation", async () => {
		const ctx = context();
		await createAttempt(ctx, base);
		await transitionAttempt(ctx, base.attemptId, "validating");
		await transitionAttempt(ctx, base.attemptId, "failed", { errorCode: "ATTEMPT_FAILED" });
		const retryId = `${base.attemptId}:recover`;
		await createAttempt(ctx, {
			...base,
			attemptId: retryId,
			predecessorAttempt: base.attemptId,
			reservationToken: "old-owner",
		});
		const applying = await transitionAttempt(ctx, retryId, "validating", {}, "old-owner");
		ctx.records.set(retryId, {
			...applying,
			state: "applying",
			leaseExpiresAt: "2020-01-01T00:00:00.000Z",
			history: [...applying.history, { state: "applying", at: applying.updatedAt }],
		});
		await expect(
			retryAttemptWork(
				{ ...ctx, syncPolicy: { repository: base.repository, branch: base.branch } } as never,
				{ attemptId: base.attemptId, idempotencyKey: "recover" },
			),
		).rejects.toThrow("ATTEMPT_INDETERMINATE_RECONCILIATION_REQUIRED");
	});

	it("shares one successful fetch/apply and persisted result across contexts", async () => {
		const records = new Map<string, unknown>();
		const runs = new Map<string, unknown>();
		const mappings = new Map<string, unknown>();
		const attempts = {
			get: async (id: string) => (records.has(id) ? { id, data: records.get(id) } : null),
			create: async (id: string, data: unknown) => {
				if (records.has(id)) return false;
				records.set(id, structuredClone(data));
				return true;
			},
			put: async (id: string, data: unknown) => records.set(id, structuredClone(data)),
			delete: async (id: string) => records.delete(id),
			query: async () => ({ items: [], hasMore: false }),
		};
		const storage = {
			sync_attempts: attempts,
			sync_runs: {
				get: async (id: string) => (runs.has(id) ? { id, data: runs.get(id) } : null),
				put: async (id: string, data: unknown) => runs.set(id, structuredClone(data)),
			},
			sync_mappings: {
				get: async (id: string) => (mappings.has(id) ? { id, data: mappings.get(id) } : null),
				put: async (id: string, data: unknown) => mappings.set(id, structuredClone(data)),
				delete: async (id: string) => mappings.delete(id),
				query: async () => ({ items: [] }),
			},
		};
		let fetches = 0;
		const sha = base.commitSha;
		const fetch = async (url: string) => {
			fetches += 1;
			if (url.includes("/git/trees/"))
				return new Response(
					JSON.stringify({
						tree: [
							{ path: "content/post.md", type: "blob", sha: "b".repeat(40) },
							{ path: "content-manifest.json", type: "blob", sha: "c".repeat(40) },
							{ path: "media-manifest.json", type: "blob", sha: "d".repeat(40) },
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			if (url.endsWith("content-manifest.json"))
				return new Response(
					JSON.stringify({
						identityManifest: {
							schemaVersion: 1,
							siteId: "site",
							entries: [
								{
									contentId: "content-launch",
									locale: "en",
									source: {
										repository: base.repository,
										branch: base.branch,
										path: "content/post.md",
										commitSha: sha,
									},
									kind: "post",
									revision: 1,
									canonicalRoute: "/posts/launch/",
								},
							],
						},
						documents: [
							{
								source: { path: "content/post.md" },
								locale: "en",
								kind: "post",
								contentId: "content-launch",
								canonical: "/posts/launch/",
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			if (url.endsWith("media-manifest.json"))
				return new Response(JSON.stringify({ schemaVersion: 1, media: [] }), {
					headers: { "content-type": "application/json" },
				});
			return new Response(
				"---\ncontentId: content-launch\nlocale: en\ntype: post\ncanonicalRoute: /posts/launch/\ntitle: Launch\nslug: launch\npublishState: draft\nupdatedAt: 2026-08-25T00:00:00.000Z\n---\nLaunch",
				{ headers: { "content-type": "text/plain" } },
			);
		};
		const content = {
			list: async () => ({ items: [] }),
			create: async () => ({
				id: "row-1",
				data: { contentId: "content-launch" },
				revision: "rev-1",
			}),
			publish: async () => ({ id: "row-1", data: {}, revision: "rev-2" }),
			get: async () => null,
			update: async () => ({ id: "row-1", data: {}, revision: "rev-2" }),
			unpublish: async () => ({ id: "row-1", data: {}, revision: "rev-2" }),
		};
		const make = () => ({
			storage,
			http: { fetch },
			content,
			syncPolicy: { repository: base.repository, branch: base.branch },
		});
		const first = make();
		await createAttempt(first as never, base);
		await transitionAttempt(first as never, base.attemptId, "validating");
		await transitionAttempt(first as never, base.attemptId, "failed", {
			errorCode: "ATTEMPT_FAILED",
		});
		const [one, two] = await Promise.all([
			retryAttemptWork(first as never, { attemptId: base.attemptId, idempotencyKey: "success" }),
			retryAttemptWork(make() as never, { attemptId: base.attemptId, idempotencyKey: "success" }),
		]);
		expect(fetches).toBe(4);
		expect(one.attempt.state).toBe("succeeded");
		expect(two.attempt).toEqual(one.attempt);
		expect(two.result).toEqual(one.result);
	});

	it.each([
		[
			"create false with missing winner",
			async () => {
				const ctx = context();
				ctx.storage.sync_attempts.create = vi.fn(async () => false);
				await expect(createAttempt(ctx, base)).rejects.toThrow("ATTEMPT_RESERVATION_UNAVAILABLE");
			},
		],
		[
			"get failure",
			async () => {
				const ctx = context();
				ctx.storage.sync_attempts.get = vi.fn(async () => {
					throw new Error("db down");
				});
				await expect(createAttempt(ctx, base)).rejects.toThrow("db down");
			},
		],
		[
			"put failure after claim",
			async () => {
				const ctx = context();
				await createAttempt(ctx, base);
				ctx.storage.sync_attempts.put = vi.fn(async () => {
					throw new Error("write failed");
				});
				await expect(transitionAttempt(ctx, base.attemptId, "validating")).rejects.toThrow(
					"write failed",
				);
				ctx.storage.sync_attempts.put = vi.fn(async (id: string, data: unknown) =>
					ctx.records.set(id, data),
				);
				await expect(transitionAttempt(ctx, base.attemptId, "validating")).resolves.toMatchObject({
					state: "validating",
				});
			},
		],
	])("storage failure matrix: %s", async (_name, run) => run());

	it("recovers the same transition intent after a target write failure and lease time advances", async () => {
		vi.useFakeTimers();
		try {
			const ctx = context();
			await createAttempt(ctx, base);
			let failPut = true;
			ctx.storage.sync_attempts.put = vi.fn(async (id: string, data: unknown) => {
				if (failPut) {
					failPut = false;
					throw new Error("target unavailable");
				}
				ctx.records.set(id, structuredClone(data));
			});
			await expect(transitionAttempt(ctx, base.attemptId, "validating")).rejects.toThrow(
				"target unavailable",
			);
			vi.advanceTimersByTime(1_000);
			await expect(transitionAttempt(ctx, base.attemptId, "validating")).resolves.toMatchObject({
				state: "validating",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects a competing semantic patch on one edge as a transition race", async () => {
		const ctx = context();
		await createAttempt(ctx, base);
		const [winner, loser] = await Promise.allSettled([
			transitionAttempt(ctx, base.attemptId, "validating", { warnings: ["content-not-found"] }),
			transitionAttempt(ctx, base.attemptId, "validating", { warnings: ["media-missing"] }),
		]);
		expect([winner, loser].filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect([winner, loser].find((result) => result.status === "rejected")).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: "ATTEMPT_TRANSITION_RACE" }),
		});
	});

	it("claims one transition slot when contenders choose different next states", async () => {
		const records = new Map<string, unknown>();
		const collection = {
			get: async (id: string) => (records.has(id) ? { id, data: records.get(id) } : null),
			create: async (id: string, data: unknown) => {
				if (records.has(id)) return false;
				records.set(id, structuredClone(data));
				return true;
			},
			put: async (id: string, data: unknown) => records.set(id, structuredClone(data)),
			delete: async (id: string) => records.delete(id),
			query: async () => ({ items: [], hasMore: false }),
		};
		const first = { storage: { sync_attempts: collection } } as never;
		const second = { storage: { sync_attempts: collection } } as never;
		await createAttempt(first, base);
		await transitionAttempt(first, base.attemptId, "validating");
		await transitionAttempt(first, base.attemptId, "planned", { planDigest: "b".repeat(64) });
		const contenders = await Promise.allSettled([
			transitionAttempt(first, base.attemptId, "skipped"),
			transitionAttempt(second, base.attemptId, "failed", { errorCode: "ATTEMPT_FAILED" }),
		]);
		expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(contenders.find((result) => result.status === "rejected")).toMatchObject({
			reason: expect.objectContaining({ message: "ATTEMPT_TRANSITION_RACE" }),
	});
	const persisted = readAttempt((await collection.get(base.attemptId))?.data);
	expect(persisted?.state).toBe(
		contenders.find((result) => result.status === "fulfilled")?.value.state,
	);
	});

	it("keeps different idempotency keys independent", async () => {
		const ctx = context();
		await createAttempt(ctx, base);
		await transitionAttempt(ctx, base.attemptId, "validating");
		await transitionAttempt(ctx, base.attemptId, "failed", { errorCode: "ATTEMPT_FAILED" });
		const make = (key: string) =>
			retryAttemptWork(
				{ ...ctx, syncPolicy: { repository: base.repository, branch: base.branch } } as never,
				{ attemptId: base.attemptId, idempotencyKey: key },
			);
		const [one, two] = await Promise.all([make("key-a"), make("key-b")]);
		expect(one.attempt.attemptId).not.toBe(two.attempt.attemptId);
	});
});
