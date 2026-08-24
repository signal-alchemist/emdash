import { describe, expect, it } from "vitest";

import {
	adaptGrowthOsExperimentResult,
	adaptGrowthOsFunnelSnapshot,
	adaptGrowthOsImprovementProposal,
	validateAnalyticsEventEnvelope,
	validateContentSyncCommand,
	validateContentSyncResult,
	validateImprovementProposal,
	validateExperimentRecord,
	validateMetricSnapshot,
	validateTraceabilityRecord,
} from "../src/index.js";

const validEvent = {
	version: 1,
	eventId: "evt-1",
	eventName: "page_view",
	occurredAt: "2026-08-25T00:00:00.000Z",
	anonymousId: "anon-1",
	sessionId: "session-1",
	path: "/lp/demo",
	payload: {},
};

describe("versioned marketing contract validators", () => {
	it("rejects excess fields and prototype-pollution keys deterministically", () => {
		expect(() => validateAnalyticsEventEnvelope({ ...validEvent, unexpected: true })).toThrow(
			"ANALYTICS_EVENT_ENVELOPE_EXCESS_FIELD:unexpected",
		);
		expect(() =>
			validateAnalyticsEventEnvelope({ ...validEvent, payload: JSON.parse('{"__proto__":{}}') }),
		).toThrow("SECURITY_FORBIDDEN_KEY:__proto__");
	});

	it("rejects direct production publish instructions", () => {
		expect(() =>
			validateContentSyncCommand({
				version: 1,
				operation: "upsert",
				source: {
					repository: "org/site",
					branch: "main",
					path: "content/a.md",
					commitSha: "0123456789abcdef0123456789abcdef01234567",
				},
				collection: "posts",
				slug: "a",
				publishState: "published",
				fields: { directPublish: true },
				media: [],
			}),
		).toThrow("CONTENT_SYNC_DIRECT_PUBLISH_FORBIDDEN");
	});

	it("rejects an improvement proposal that asks an agent to publish directly", () => {
		expect(() =>
			validateImprovementProposal({
				version: 1,
				proposalId: "proposal-1",
				target: { kind: "landing_page", path: "/lp/demo" },
				status: "proposed",
				diagnosis: "low conversion",
				uncertainty: ["u"],
				evidence: [{ snapshotId: "s", metricIds: [], observation: "o", strength: "weak" }],
				hypothesis: "improve CTA",
				proposedChanges: [
					{ repository: "org/site", path: "src/lp.ts", summary: "publish directly" },
				],
				expectedOutcome: "higher conversion",
				regressionRisks: [],
				verificationPlan: ["review"],
				createdAt: "2026-08-25T00:00:00.000Z",
				createdBy: "agent",
				confidence: 0.5,
				assumptions: ["a"],
				missingEvidence: ["m"],
				evidenceRefs: ["e"],
				requiredHumanDecisions: ["d"],
			}),
		).toThrow("IMPROVEMENT_PROPOSAL_DIRECT_PUBLISH_FORBIDDEN");
	});

	it("adapts pinned Growth-OS fixtures into stable contracts", () => {
		const funnel = adaptGrowthOsFunnelSnapshot({
			funnelSnapshotId: "funnel-1",
			organizationId: "org-1",
			funnelKey: "toc_basic",
			periodStart: "2026-08-01T00:00:00.000Z",
			periodEnd: "2026-08-25T00:00:00.000Z",
			steps: [
				{ stepKey: "page_view", eventType: "page_view", count: 100 },
				{ stepKey: "cta_click", eventType: "cta_click", count: 20, conversionFromPrevious: 0.2 },
			],
			bottlenecks: ["cta_click"],
			createdAt: "2026-08-25T00:00:00.000Z",
		});
		expect(funnel.snapshotId).toBe("funnel-1");
		expect(funnel.funnel.pageViews).toBe(100);
		expect(funnel.funnel.ctaClicks).toBe(20);

		const experiment = adaptGrowthOsExperimentResult({
			experimentId: "exp-1",
			periodStart: "2026-08-01T00:00:00.000Z",
			periodEnd: "2026-08-25T00:00:00.000Z",
			variantResults: [
				{ variantKey: "a", exposures: 2, conversions: 0, conversionRate: 0, revenue: 0 },
				{ variantKey: "b", exposures: 2, conversions: 1, conversionRate: 0.5, revenue: 10 },
			],
			confidenceNote: "insufficient sample",
			decision: "needs_more_data",
			createdAt: "2026-08-25T00:00:00.000Z",
		});
		expect(experiment.decision).toBe("inconclusive");

		const proposal = adaptGrowthOsImprovementProposal({
			proposalId: "proposal-1",
			proposalType: "lp",
			path: "/lp/demo",
			confidence: 0.7,
			uncertainty: ["small sample"],
			assumptions: ["CTA is the bottleneck"],
			missingEvidence: ["fresh traffic"],
			evidenceRefs: ["analytics://snapshot/1"],
			recommendedActions: ["improve CTA"],
			actionsNotRecommended: ["skip review"],
			requiredHumanDecisions: ["Approve the experiment"],
			opsImpact: {
				operationType: "content_publish",
				operationRisk: "medium",
				requiresOperationalGate: true,
				requiresSignalCoreApproval: false,
			},
			createdAt: "2026-08-25T00:00:00.000Z",
		});
		expect(proposal.target).toEqual({ kind: "landing_page", path: "/lp/demo" });
	});

	it.each([
		["unsupported version", { version: 2 }, "EXPERIMENT_RECORD_VERSION_UNSUPPORTED"],
		[
			"too few variants",
			{ version: 1, experimentId: "e", status: "draft", variants: [] },
			"EXPERIMENT_RECORD_VARIANTS_REQUIRED",
		],
	])("fails closed for %s", (_label, value, code) => {
		expect(() => validateExperimentRecord(value)).toThrow(code);
	});

	it.each([
		[
			"nested analytics viewport",
			() => validateAnalyticsEventEnvelope({ ...validEvent, viewport: { width: 0, height: 1 } }),
			"ANALYTICS_VIEWPORT_WIDTH_INVALID",
		],
		[
			"nested metric count",
			() =>
				validateMetricSnapshot({
					version: 1,
					snapshotId: "s",
					target: { kind: "landing_page", path: "/lp" },
					window: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
					definitions: [],
					funnel: {
						sessions: -1,
						pageViews: 1,
						ctaExposures: 1,
						ctaClicks: 1,
						formStarts: 1,
						conversions: 1,
					},
					custom: {},
					sampleWarnings: [],
					generatedAt: "2026-01-01T00:00:00Z",
				}),
			"METRIC_SNAPSHOT_SESSIONS_INVALID",
		],
		[
			"sync media hash",
			() =>
				validateContentSyncCommand({
					version: 1,
					operation: "upsert",
					source: {
						repository: "org/site",
						branch: "main",
						path: "content/a.md",
						commitSha: "0123456789abcdef0123456789abcdef01234567",
					},
					collection: "posts",
					slug: "a",
					publishState: "draft",
					fields: {},
					media: [
						{ sourcePath: "a.png", sha256: "bad", mimeType: "image/png", bytes: 1, alt: "a" },
					],
				}),
			"CONTENT_SYNC_MEDIA_HASH_INVALID",
		],
		[
			"result nested source",
			() =>
				validateContentSyncResult({
					version: 1,
					source: { repository: "bad", branch: "main", path: "a", commitSha: "abcdef1" },
					status: "accepted",
					uploadedMediaIds: [],
					warnings: [],
					completedAt: "2026-01-01T00:00:00Z",
				}),
			"CONTENT_SYNC_RESULT_SOURCE_REPOSITORY_INVALID",
		],
		[
			"traceability check enum",
			() =>
				validateTraceabilityRecord({
					version: 1,
					repository: "org/site",
					branch: "main",
					commitSha: "0123456789abcdef0123456789abcdef01234567",
					actor: "a",
					checks: [{ name: "x", status: "bad" }],
				}),
			"TRACEABILITY_CHECK_STATUS_INVALID",
		],
		[
			"experiment allocation",
			() =>
				validateExperimentRecord({
					version: 1,
					experimentId: "e",
					target: { kind: "landing_page", path: "/lp" },
					status: "draft",
					hypothesis: "h",
					primaryMetricId: "m",
					guardrailMetricIds: [],
					variants: [
						{ id: "a", label: "A", allocation: 0.6 },
						{ id: "b", label: "B", allocation: 0.6 },
					],
					evidenceSnapshotIds: [],
				}),
			"EXPERIMENT_RECORD_ALLOCATION_TOTAL_INVALID",
		],
	])("rejects malformed nested contract: %s", (_label, run, code) => {
		expect(run).toThrow(code);
	});

	it("bounds hostile graphs and returns detached normalized records", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => validateAnalyticsEventEnvelope({ ...validEvent, payload: cyclic })).toThrow(
			"SECURITY_INPUT_CYCLE",
		);
		const input = {
			...validEvent,
			viewport: { width: 1200, height: 800 },
			payload: { nested: { ok: true } },
		};
		const normalized = validateAnalyticsEventEnvelope(input);
		expect(normalized).not.toBe(input);
		expect(normalized.viewport).toEqual({ width: 1200, height: 800 });
	});

	it.each([
		[
			"uppercase SHA",
			"0123456789ABCDEF0123456789ABCDEF01234567",
			"CONTENT_SYNC_SOURCE_COMMIT_INVALID",
		],
		["unsafe source path", "content\\a.md", "CONTENT_SYNC_SOURCE_PATH_INVALID"],
		["zero media bytes", "zero-bytes", "CONTENT_SYNC_MEDIA_BYTES_INVALID"],
	])("isolates sync security failure: %s", (_label, value, code) => {
		const command = {
			version: 1,
			operation: "upsert",
			source: {
				repository: "org/site",
				branch: "main",
				path: value === "content\\a.md" ? value : "content/a.md",
				commitSha: value.length === 40 ? value : "0123456789abcdef0123456789abcdef01234567",
			},
			collection: "posts",
			slug: "a",
			publishState: "draft",
			fields: {},
			media:
				value === "zero-bytes"
					? [
							{
								sourcePath: "a.png",
								sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
								mimeType: "image/png",
								bytes: 0,
								alt: "a",
							},
						]
					: [],
		};
		expect(() => validateContentSyncCommand(command)).toThrow(code);
	});

	it("preserves valid nested funnel maps and rejects non-integer counts", () => {
		const snapshot = {
			version: 1,
			snapshotId: "s",
			target: { kind: "landing_page", path: "/lp" },
			window: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
			definitions: [],
			funnel: {
				sessions: 2,
				pageViews: 2,
				sectionExposures: { hero: 2 },
				scrollDepth: { "25": 2 },
				ctaExposures: 1,
				ctaClicks: 1,
				formStarts: 1,
				conversions: 1,
			},
			custom: {},
			sampleWarnings: [],
			generatedAt: "2026-01-02T00:00:00Z",
		};
		expect(validateMetricSnapshot(snapshot).funnel.sectionExposures).toEqual({ hero: 2 });
		expect(() =>
			validateMetricSnapshot({ ...snapshot, funnel: { ...snapshot.funnel, sessions: 1.5 } }),
		).toThrow("METRIC_SNAPSHOT_SESSIONS_INVALID");
	});

	it("rejects experiment date and URL policy violations independently", () => {
		const experiment = {
			version: 1,
			experimentId: "e",
			target: { kind: "landing_page", path: "/lp" },
			status: "draft",
			hypothesis: "h",
			primaryMetricId: "m",
			guardrailMetricIds: [],
			variants: [
				{ id: "a", label: "A", allocation: 0.5 },
				{ id: "b", label: "B", allocation: 0.5 },
			],
			startedAt: "2026-02-01T00:00:00Z",
			endedAt: "2026-01-01T00:00:00Z",
			evidenceSnapshotIds: [],
		};
		expect(() => validateExperimentRecord(experiment)).toThrow(
			"EXPERIMENT_RECORD_DATE_ORDER_INVALID",
		);
		expect(() =>
			validateExperimentRecord({
				...experiment,
				endedAt: undefined,
				sourcePullRequestUrl: "http://example.com",
			}),
		).toThrow("EXPERIMENT_RECORD_URL_INVALID");
	});

	it.each([
		["dot segment", "content/./a.md"],
		["parent segment", "content/../a.md"],
		["empty segment", "content//a.md"],
		["query", "content/a.md?x"],
		["fragment", "content/a.md#x"],
		["empty", ""],
	])("rejects unsafe relative source path: %s", (_label, pathValue) => {
		expect(() =>
			validateContentSyncCommand({
				version: 1,
				operation: "upsert",
				source: {
					repository: "org/site",
					branch: "main",
					path: pathValue,
					commitSha: "0123456789abcdef0123456789abcdef01234567",
				},
				collection: "posts",
				slug: "a",
				publishState: "draft",
				fields: {},
				media: [],
			}),
		).toThrow("CONTENT_SYNC_SOURCE_PATH_INVALID");
	});

	it("accepts legitimate double-dot filename and preserves both funnel maps", () => {
		const command = {
			version: 1,
			operation: "upsert",
			source: {
				repository: "org/site",
				branch: "main",
				path: "content/post..md",
				commitSha: "0123456789abcdef0123456789abcdef01234567",
			},
			collection: "posts",
			slug: "a",
			publishState: "draft",
			fields: {},
			media: [],
		};
		expect(validateContentSyncCommand(command).source.path).toBe("content/post..md");
		const snapshot = {
			version: 1,
			snapshotId: "s",
			target: { kind: "landing_page", path: "/lp" },
			window: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
			definitions: [],
			funnel: {
				sessions: 2,
				pageViews: 2,
				sectionExposures: { hero: 2 },
				scrollDepth: { "25": 2, "50": 1 },
				ctaExposures: 1,
				ctaClicks: 1,
				formStarts: 1,
				conversions: 1,
			},
			custom: {},
			sampleWarnings: [],
			generatedAt: "2026-01-02T00:00:00Z",
		};
		expect(validateMetricSnapshot(snapshot).funnel.scrollDepth).toEqual({ "25": 2, "50": 1 });
		expect(() =>
			validateMetricSnapshot({
				...snapshot,
				funnel: { ...snapshot.funnel, scrollDepth: { "10": 1 } },
			}),
		).toThrow("METRIC_SNAPSHOT_SCROLL_DEPTH_KEY_INVALID");
	});

	it("rejects inconsistent nonzero conversion rates", () => {
		expect(() =>
			adaptGrowthOsExperimentResult({
				experimentId: "exp-1",
				periodStart: "2026-01-01T00:00:00Z",
				periodEnd: "2026-01-02T00:00:00Z",
				variantResults: [
					{ variantKey: "a", exposures: 2, conversions: 1, conversionRate: 0, revenue: 0 },
					{ variantKey: "b", exposures: 2, conversions: 1, conversionRate: 0.5, revenue: 0 },
				],
				confidenceNote: "x",
				decision: "needs_more_data",
				createdAt: "2026-01-02T00:00:00Z",
			}),
		).toThrow("GROWTH_EXPERIMENT_FIXTURE_INVALID_VARIANT");
	});

	it("rejects nonzero zero-exposure rates and accepts zero rate", () => {
		const fixture = {
			experimentId: "exp-1",
			periodStart: "2026-01-01T00:00:00Z",
			periodEnd: "2026-01-02T00:00:00Z",
			variantResults: [
				{ variantKey: "a", exposures: 0, conversions: 0, conversionRate: 0.1, revenue: 0 },
				{ variantKey: "b", exposures: 2, conversions: 1, conversionRate: 0.5, revenue: 0 },
			],
			confidenceNote: "x",
			decision: "needs_more_data" as const,
			createdAt: "2026-01-02T00:00:00Z",
		};
		expect(() => adaptGrowthOsExperimentResult(fixture)).toThrow(
			"GROWTH_EXPERIMENT_FIXTURE_INVALID_VARIANT",
		);
		expect(
			adaptGrowthOsExperimentResult({
				...fixture,
				variantResults: [
					{ ...fixture.variantResults[0], conversionRate: 0 },
					fixture.variantResults[1],
				],
			}).decision,
		).toBe("inconclusive");
	});

	it("isolates traceability URL policies and accepts HTTPS", () => {
		expect(() =>
			validateTraceabilityRecord({
				version: 1,
				repository: "org/site",
				branch: "main",
				commitSha: "0123456789abcdef0123456789abcdef01234567",
				actor: "a",
				checks: [{ name: "x", status: "passed", url: "http://example.com" }],
			}),
		).toThrow("TRACEABILITY_CHECK_URL_INVALID");
		expect(() =>
			validateTraceabilityRecord({
				version: 1,
				repository: "org/site",
				branch: "main",
				commitSha: "0123456789abcdef0123456789abcdef01234567",
				actor: "a",
				previewUrl: "http://example.com",
				checks: [{ name: "x", status: "passed" }],
			}),
		).toThrow("TRACEABILITY_RECORD_PREVIEW_URL_INVALID");
		expect(
			validateTraceabilityRecord({
				version: 1,
				repository: "org/site",
				branch: "main",
				commitSha: "0123456789abcdef0123456789abcdef01234567",
				actor: "a",
				previewUrl: "https://example.com",
				checks: [{ name: "x", status: "passed", url: "https://example.com" }],
			}).previewUrl,
		).toBe("https://example.com");
	});

	it.each([
		[
			"MIME",
			{
				sourcePath: "a.png",
				sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				mimeType: "bad",
				bytes: 1,
				alt: "a",
			},
			"CONTENT_SYNC_MEDIA_MIME_INVALID",
		],
		[
			"width-only",
			{
				sourcePath: "a.png",
				sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				mimeType: "image/png",
				bytes: 1,
				width: 2,
				alt: "a",
			},
			"CONTENT_SYNC_MEDIA_DIMENSIONS_INVALID",
		],
		[
			"height-only",
			{
				sourcePath: "a.png",
				sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				mimeType: "image/png",
				bytes: 1,
				height: 2,
				alt: "a",
			},
			"CONTENT_SYNC_MEDIA_DIMENSIONS_INVALID",
		],
	])("isolates media metadata failure: %s", (_label, media, code) => {
		expect(() =>
			validateContentSyncCommand({
				version: 1,
				operation: "upsert",
				source: {
					repository: "org/site",
					branch: "main",
					path: "content/a.md",
					commitSha: "0123456789abcdef0123456789abcdef01234567",
				},
				collection: "posts",
				slug: "a",
				publishState: "draft",
				fields: {},
				media: [media],
			}),
		).toThrow(code);
	});

	it("accepts adapter URL paths containing a legitimate double-dot filename", () => {
		const proposal = adaptGrowthOsImprovementProposal({
			proposalId: "proposal-1",
			proposalType: "lp",
			path: "/lp/post..draft",
			confidence: 0.5,
			uncertainty: ["u"],
			assumptions: [],
			missingEvidence: [],
			evidenceRefs: ["analytics://s"],
			recommendedActions: ["review"],
			actionsNotRecommended: [],
			requiredHumanDecisions: ["approve"],
			opsImpact: {
				operationType: "content_proposal",
				operationRisk: "low",
				requiresOperationalGate: false,
				requiresSignalCoreApproval: false,
			},
			createdAt: "2026-01-01T00:00:00Z",
		});
		expect(proposal.target).toEqual({ kind: "landing_page", path: "/lp/post..draft" });
	});
});
