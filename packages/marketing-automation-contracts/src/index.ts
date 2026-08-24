export type ISODateTime = string;
export type CommitSha = string;
export type ContentId = string;
export type MediaId = string;

export interface GitSourceRef {
	repository: string;
	branch: string;
	path: string;
	commitSha: CommitSha;
	deliveryId?: string;
}

export interface MediaSourceRef {
	sourcePath: string;
	sha256: string;
	mimeType: string;
	bytes: number;
	width?: number;
	height?: number;
	alt: string;
	emdashMediaId?: MediaId;
}

export type PublishState = "draft" | "published" | "scheduled" | "unpublished";
export type SyncOperation = "upsert" | "rename" | "unpublish" | "delete";

export interface ContentSyncCommand {
	version: 1;
	operation: SyncOperation;
	source: GitSourceRef;
	collection: string;
	contentId?: ContentId;
	slug: string;
	previousSlug?: string;
	expectedRevision?: string;
	publishState: PublishState;
	scheduledFor?: ISODateTime;
	fields: Record<string, unknown>;
	media: MediaSourceRef[];
}

export type SyncRunStatus = "accepted" | "skipped" | "succeeded" | "conflict" | "failed";

export interface ContentSyncResult {
	version: 1;
	source: GitSourceRef;
	status: SyncRunStatus;
	contentId?: ContentId;
	revision?: string;
	uploadedMediaIds: MediaId[];
	warnings: string[];
	errorCode?: string;
	errorMessage?: string;
	completedAt: ISODateTime;
}

export type AnalyticsEventName =
	| "page_view"
	| "section_exposure"
	| "scroll_depth"
	| "cta_exposure"
	| "cta_click"
	| "form_start"
	| "form_submit"
	| "conversion"
	| "revenue"
	| "experiment_exposure";

export interface CampaignAttribution {
	source?: string;
	medium?: string;
	campaign?: string;
	term?: string;
	content?: string;
	clickId?: string;
}

export interface ExperimentAttribution {
	experimentId: string;
	variantId: string;
	assignedAt: ISODateTime;
}

export interface AnalyticsEventEnvelope<
	TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
	version: 1;
	eventId: string;
	eventName: AnalyticsEventName;
	occurredAt: ISODateTime;
	receivedAt?: ISODateTime;
	anonymousId: string;
	sessionId: string;
	path: string;
	referrer?: string;
	contentId?: ContentId;
	deploymentSha?: CommitSha;
	viewport?: { width: number; height: number };
	campaign?: CampaignAttribution;
	experiment?: ExperimentAttribution;
	payload: TPayload;
}

export interface FunnelCounts {
	impressions?: number;
	clicks?: number;
	sessions: number;
	pageViews: number;
	sectionExposures?: Record<string, number>;
	scrollDepth?: Record<"25" | "50" | "75" | "90" | "100", number>;
	ctaExposures: number;
	ctaClicks: number;
	formStarts: number;
	conversions: number;
	revenueMinor?: number;
	currency?: string;
}

export interface MetricDefinition {
	id: string;
	label: string;
	numerator?: string;
	denominator?: string;
	unit: "count" | "ratio" | "currency" | "duration" | "position";
	source: string;
}

export interface MetricSnapshot {
	version: 1;
	snapshotId: string;
	target: ImprovementTarget;
	window: { from: ISODateTime; to: ISODateTime };
	definitions: MetricDefinition[];
	funnel: FunnelCounts;
	custom: Record<string, number | null>;
	sampleWarnings: string[];
	generatedAt: ISODateTime;
	sourceCommit?: CommitSha;
}

export type ImprovementTarget =
	| { kind: "content"; contentId: ContentId; path: string }
	| { kind: "landing_page"; path: string }
	| { kind: "section"; path: string; sectionId: string }
	| { kind: "metadata"; path: string; field: "title" | "description" | "canonical" | "schema" };

export type EvidenceStrength = "weak" | "moderate" | "strong";
export type ProposalStatus = "proposed" | "approved" | "rejected" | "implemented" | "reverted";
export type GrowthOperationType =
	| "content_draft"
	| "content_proposal"
	| "content_edit"
	| "content_publish"
	| "bulk_publish"
	| "experiment_config"
	| "tracking_config"
	| "custom_code_draft"
	| "custom_code_publish"
	| "revalidate"
	| "revalidate_paths"
	| "revalidate_tags"
	| "revalidate_all"
	| "route_template_change"
	| "schema_change"
	| "deployment"
	| "restore_apply"
	| "incident_response"
	| "quality_evaluate"
	| "approval"
	| "knowledge_activate";
export type GrowthOperationRisk = "low" | "medium" | "high" | "critical";

export interface ImprovementProposal {
	version: 1;
	proposalId: string;
	target: ImprovementTarget;
	status: ProposalStatus;
	diagnosis: string;
	uncertainty: string[];
	evidence: Array<{
		snapshotId: string;
		metricIds: string[];
		observation: string;
		strength: EvidenceStrength;
	}>;
	hypothesis: string;
	proposedChanges: Array<{
		repository: string;
		path: string;
		summary: string;
	}>;
	expectedOutcome: string;
	regressionRisks: string[];
	verificationPlan: string[];
	createdAt: ISODateTime;
	createdBy: string;
	confidence: number;
	assumptions: string[];
	missingEvidence: string[];
	evidenceRefs: string[];
	requiredHumanDecisions: string[];
	proposalType?: "content" | "seo" | "cta" | "lp" | "experiment" | "custom_code" | "publish_plan";
	recommendedActions?: string[];
	actionsNotRecommended?: string[];
	opsImpact?: {
		operationType: GrowthOperationType;
		operationRisk: GrowthOperationRisk;
		requiresOperationalGate: boolean;
		requiresSignalCoreApproval: boolean;
	};
	branch?: string;
	pullRequestUrl?: string;
}

export type ExperimentStatus = "draft" | "running" | "paused" | "completed" | "reverted";

export type ExperimentDecision = "win" | "loss" | "inconclusive" | "reverted";

export interface ExperimentRecord {
	version: 1;
	experimentId: string;
	target: ImprovementTarget;
	status: ExperimentStatus;
	hypothesis: string;
	primaryMetricId: string;
	guardrailMetricIds: string[];
	variants: Array<{
		id: string;
		label: string;
		allocation?: number;
		deploymentSha?: CommitSha;
	}>;
	startedAt?: ISODateTime;
	endedAt?: ISODateTime;
	decision?: ExperimentDecision;
	decisionReason?: string;
	evidenceSnapshotIds: string[];
	sourcePullRequestUrl?: string;
}

export interface TraceabilityRecord {
	version: 1;
	repository: string;
	branch: string;
	commitSha: CommitSha;
	actor: string;
	proposalId?: string;
	experimentId?: string;
	previewUrl?: string;
	checks: Array<{ name: string; status: "passed" | "failed" | "skipped"; url?: string }>;
	approvedBy?: string;
	approvedAt?: ISODateTime;
}

export {
	serializeContentCatalog,
	validateContentIdentityManifest,
	type ContentCatalog,
	type ContentCatalogEntry,
	type ContentIdentityDocument,
	type ContentIdentityEntry,
	type ContentIdentityManifest,
} from "./content-catalog.js";

export {
	adaptGrowthOsExperimentResult,
	adaptGrowthOsFunnelSnapshot,
	adaptGrowthOsImprovementProposal,
} from "./adapters.js";
export type {
	GrowthOsExperimentResultFixture,
	GrowthOsFunnelSnapshotFixture,
	GrowthOsImprovementProposalFixture,
} from "./adapters.js";
export {
	ContractValidationError,
	validateAnalyticsEventEnvelope,
	validateContentSyncCommand,
	validateContentSyncResult,
	validateExperimentRecord,
	validateImprovementProposal,
	validateMetricSnapshot,
	validateTraceabilityRecord,
} from "./validators.js";
