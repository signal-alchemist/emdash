import type {
	GrowthOperationRisk,
	GrowthOperationType,
	ImprovementProposal,
	MetricSnapshot,
} from "./index.js";
import { validateImprovementProposal, validateMetricSnapshot } from "./validators.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const unsafePathChars = (value: string): boolean =>
	value.includes("?") || value.includes("#") || Array.from(value, (char) => char.charCodeAt(0)).some((code) => code < 32);
const integer = (v: number): boolean => Number.isInteger(v) && v >= 0;
const date = (v: string): boolean => !Number.isNaN(Date.parse(v));
const safePath = (v: string): boolean =>
	v.startsWith("/") &&
	!v.includes("\\") &&
	!v.includes("//") &&
	v
		.split("/")
		.slice(1)
		.every((segment) => segment !== "." && segment !== "..") &&
	!unsafePathChars(v);

export interface GrowthOsFunnelSnapshotFixture {
	funnelSnapshotId: string;
	organizationId: string;
	funnelKey: string;
	periodStart: string;
	periodEnd: string;
	steps: Array<{
		stepKey: string;
		eventType: string;
		count: number;
		conversionFromPrevious?: number;
	}>;
	bottlenecks: string[];
	createdAt: string;
}
export interface GrowthOsExperimentResultFixture {
	experimentId: string;
	periodStart: string;
	periodEnd: string;
	variantResults: Array<{
		variantKey: string;
		exposures: number;
		conversions: number;
		conversionRate: number;
		revenue: number;
	}>;
	confidenceNote: string;
	decision: "continue" | "ship_winner" | "stop" | "needs_more_data";
	createdAt: string;
}
export interface GrowthOsImprovementProposalFixture {
	proposalId: string;
	proposalType: "content" | "seo" | "cta" | "lp" | "experiment" | "custom_code" | "publish_plan";
	path: string;
	confidence: number;
	uncertainty: string[];
	assumptions: string[];
	missingEvidence: string[];
	evidenceRefs: string[];
	recommendedActions: string[];
	actionsNotRecommended: string[];
	requiredHumanDecisions: string[];
	opsImpact: {
		operationType: GrowthOperationType;
		operationRisk: GrowthOperationRisk;
		requiresOperationalGate: boolean;
		requiresSignalCoreApproval: boolean;
	};
	createdAt: string;
}

function period(start: string, end: string, code: string): void {
	if (!date(start) || !date(end) || Date.parse(end) < Date.parse(start)) throw new Error(code);
}
function checkId(value: string, code: string): void {
	if (!ID.test(value)) throw new Error(code);
}

export function adaptGrowthOsFunnelSnapshot(
	fixture: GrowthOsFunnelSnapshotFixture,
): MetricSnapshot {
	checkId(fixture.funnelSnapshotId, "GROWTH_FUNNEL_FIXTURE_INVALID_ID");
	checkId(fixture.organizationId, "GROWTH_FUNNEL_FIXTURE_INVALID_ORGANIZATION");
	if (!Array.isArray(fixture.steps)) throw new Error("GROWTH_FUNNEL_FIXTURE_INVALID_STEPS");
	checkId(fixture.funnelKey, "GROWTH_FUNNEL_FIXTURE_INVALID_KEY");
	period(fixture.periodStart, fixture.periodEnd, "GROWTH_FUNNEL_FIXTURE_INVALID_PERIOD");
	if (
		!date(fixture.createdAt) ||
		!Array.isArray(fixture.bottlenecks) ||
		fixture.bottlenecks.some((x) => !x)
	)
		throw new Error("GROWTH_FUNNEL_FIXTURE_INVALID_METADATA");
	const keys = new Set<string>();
	for (const step of fixture.steps) {
		checkId(step.stepKey, "GROWTH_FUNNEL_FIXTURE_INVALID_STEP");
		if (typeof step.eventType !== "string" || !step.eventType || step.eventType.length > 128)
			throw new Error("GROWTH_FUNNEL_FIXTURE_INVALID_STEP");
		if (
			keys.has(step.stepKey) ||
			!integer(step.count) ||
			(step.conversionFromPrevious !== undefined &&
				(!Number.isFinite(step.conversionFromPrevious) ||
					step.conversionFromPrevious < 0 ||
					step.conversionFromPrevious > 1))
		)
			throw new Error("GROWTH_FUNNEL_FIXTURE_INVALID_STEP");
		keys.add(step.stepKey);
	}
	const count = (types: string[]) =>
		fixture.steps.filter((s) => types.includes(s.eventType)).reduce((sum, s) => sum + s.count, 0);
	const output = {
		version: 1 as const,
		snapshotId: fixture.funnelSnapshotId,
		target: { kind: "landing_page" as const, path: `/${fixture.funnelKey}` },
		window: { from: fixture.periodStart, to: fixture.periodEnd },
		definitions: [],
		funnel: {
			sessions: count(["page_view"]),
			pageViews: count(["page_view"]),
			ctaExposures: count(["cta_exposure"]),
			ctaClicks: count(["cta_click"]),
			formStarts: count(["form_start"]),
			conversions: count(["lead_created", "form_submit", "purchase_created"]),
		},
		custom: { bottleneckCount: fixture.bottlenecks.length },
		sampleWarnings: [],
		generatedAt: fixture.createdAt,
	};
	return validateMetricSnapshot(output);
}

export function adaptGrowthOsExperimentResult(
	fixture: GrowthOsExperimentResultFixture,
): MetricSnapshot & { decision: "win" | "loss" | "inconclusive" | "reverted" } {
	checkId(fixture.experimentId, "GROWTH_EXPERIMENT_FIXTURE_INVALID_ID");
	period(fixture.periodStart, fixture.periodEnd, "GROWTH_EXPERIMENT_FIXTURE_INVALID_PERIOD");
	if (
		!date(fixture.createdAt) ||
		!Array.isArray(fixture.variantResults) ||
		fixture.variantResults.length < 2
	)
		throw new Error("GROWTH_EXPERIMENT_FIXTURE_INVALID_VARIANTS");
	const keys = new Set<string>();
	for (const result of fixture.variantResults) {
		checkId(result.variantKey, "GROWTH_EXPERIMENT_FIXTURE_INVALID_VARIANT");
		if (
			keys.has(result.variantKey) ||
			!integer(result.exposures) ||
			!integer(result.conversions) ||
			result.conversions > result.exposures ||
			!Number.isFinite(result.conversionRate) ||
			result.conversionRate < 0 ||
			result.conversionRate > 1 ||
			(result.exposures === 0
				? result.conversionRate !== 0
				: Math.abs(result.conversionRate - result.conversions / result.exposures) > 1e-9) ||
			!Number.isFinite(result.revenue) ||
			result.revenue < 0
		)
			throw new Error("GROWTH_EXPERIMENT_FIXTURE_INVALID_VARIANT");
		keys.add(result.variantKey);
	}
	const decision =
		fixture.decision === "needs_more_data"
			? "inconclusive"
			: fixture.decision === "ship_winner"
				? "win"
				: fixture.decision === "stop"
					? "loss"
					: "inconclusive";
	const output = {
		version: 1 as const,
		snapshotId: fixture.experimentId,
		target: { kind: "landing_page" as const, path: `/experiments/${fixture.experimentId}` },
		window: { from: fixture.periodStart, to: fixture.periodEnd },
		definitions: [],
		funnel: {
			sessions: fixture.variantResults.reduce((sum, x) => sum + x.exposures, 0),
			pageViews: 0,
			ctaExposures: 0,
			ctaClicks: 0,
			formStarts: 0,
			conversions: fixture.variantResults.reduce((sum, x) => sum + x.conversions, 0),
		},
		custom: { revenue: fixture.variantResults.reduce((sum, x) => sum + x.revenue, 0) },
		sampleWarnings: [fixture.confidenceNote],
		generatedAt: fixture.createdAt,
	};
	return { ...validateMetricSnapshot(output), decision };
}

export function adaptGrowthOsImprovementProposal(
	fixture: GrowthOsImprovementProposalFixture,
): ImprovementProposal {
	checkId(fixture.proposalId, "GROWTH_PROPOSAL_INVALID_ID");
	if (!safePath(fixture.path)) throw new Error("GROWTH_PROPOSAL_INVALID_PATH");
	if (!date(fixture.createdAt)) throw new Error("GROWTH_PROPOSAL_INVALID_DATE");
	return validateImprovementProposal({
		version: 1,
		proposalId: fixture.proposalId,
		target: { kind: "landing_page", path: fixture.path },
		status: "proposed",
		diagnosis: fixture.uncertainty[0] ?? "Growth-OS proposal",
		uncertainty: fixture.uncertainty,
		evidence: fixture.evidenceRefs.map((snapshotId) => ({
			snapshotId,
			metricIds: [],
			observation: "Growth-OS evidence reference",
			strength: "moderate" as const,
		})),
		hypothesis: fixture.recommendedActions[0] ?? "Validate the proposed change.",
		proposedChanges: [],
		expectedOutcome: fixture.recommendedActions.join("; "),
		regressionRisks: [],
		verificationPlan: fixture.requiredHumanDecisions,
		createdAt: fixture.createdAt,
		createdBy: "growth-os-adapter",
		confidence: fixture.confidence,
		assumptions: fixture.assumptions,
		missingEvidence: fixture.missingEvidence,
		evidenceRefs: fixture.evidenceRefs,
		requiredHumanDecisions: fixture.requiredHumanDecisions,
		proposalType: fixture.proposalType,
		recommendedActions: fixture.recommendedActions,
		actionsNotRecommended: fixture.actionsNotRecommended,
		opsImpact: fixture.opsImpact,
	});
}
