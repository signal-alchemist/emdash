import type {
	AnalyticsEventEnvelope,
	ContentSyncCommand,
	ContentSyncResult,
	ExperimentRecord,
	ImprovementProposal,
	MetricSnapshot,
	TraceabilityRecord,
} from "./index.js";

export class ContractValidationError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "ContractValidationError";
		this.code = code;
	}
}
const MAX_STRING = 2048,
	MAX_DEPTH = 16,
	MAX_NODES = 1000;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const MIME = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/;
const SAFE_MAP_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const unsafeChars = (value: string): boolean =>
	value.includes("?") || value.includes("#") || Array.from(value, (char) => char.charCodeAt(0)).some((code) => code < 32);
const SECRET = /(secret|token|cookie|authorization|rawhtml|<script|javascript:|set-cookie)/i;
const DIRECT_KEY = /directpublish|automerge|publishwithoutreview/i;
const DIRECT_VALUE = /publish directly|direct publish|auto.?merge/i;
const PRIVATE_KEY =
	/^(email|name|phone|address|password|ip|userAgent|formValue|formValues|html|dom|replay|screenshot)$/i;
const keyCode = (v: string) => v.replace(/[^a-zA-Z0-9_.-]/g, "?").slice(0, 64);
function fail(code: string): never {
	throw new ContractValidationError(code);
}
function scan(value: unknown): void {
	const seen = new WeakSet();
	let nodes = 0;
	function visit(v: unknown, p: string, d: number): void {
		if (++nodes > MAX_NODES || d > MAX_DEPTH) fail("SECURITY_INPUT_BOUNDS");
		if (typeof v === "string") {
			if (SECRET.test(v) || (!p.includes(".actionsNotRecommended.") && DIRECT_VALUE.test(v)))
				fail(`SECURITY_FORBIDDEN_VALUE:${keyCode(p)}`);
			return;
		}
		if (Array.isArray(v)) {
			v.forEach((x, i) => visit(x, `${p}.${i}`, d + 1));
			return;
		}
		if (v && typeof v === "object") {
			if (seen.has(v)) fail("SECURITY_INPUT_CYCLE");
			seen.add(v);
			const proto = Object.getPrototypeOf(v);
			if (proto !== Object.prototype && proto !== null)
				fail(`SECURITY_FORBIDDEN_PROTOTYPE:${keyCode(p)}`);
			for (const [k, x] of Object.entries(v)) {
				if (FORBIDDEN.has(k) || SECRET.test(k) || (p.includes("payload") && PRIVATE_KEY.test(k)))
					fail(`SECURITY_FORBIDDEN_KEY:${keyCode(k)}`);
				visit(x, `${p}.${keyCode(k)}`, d + 1);
			}
		}
	}
	visit(value, "root", 0);
}
function obj(v: unknown, code: string): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) fail(code);
	const p = Object.getPrototypeOf(v);
	if (p !== Object.prototype && p !== null) fail(`${code}_PROTOTYPE`);
	return Object.fromEntries(Object.entries(v));
}
function exact(v: unknown, keys: readonly string[], code: string): Record<string, unknown> {
	const o = obj(v, code),
		allowed = new Set(keys);
	for (const k of Object.keys(o)) {
		if (FORBIDDEN.has(k)) fail(`${code}_FORBIDDEN_FIELD:${keyCode(k)}`);
		if (!allowed.has(k)) fail(`${code}_EXCESS_FIELD:${keyCode(k)}`);
	}
	return o;
}
function text(v: unknown, code: string, max = MAX_STRING): string {
	if (typeof v !== "string" || !v || v.length > max) fail(code);
	return v;
}
function strings(v: unknown, code: string, required = false): string[] {
	if (!Array.isArray(v) || (required && !v.length)) fail(code);
	return v.map((x: unknown) => text(x, `${code}_ITEM`));
}
function finite(v: unknown, code: string, min = 0, max = Infinity): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(code);
	return v;
}
function count(v: unknown, code: string): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(code);
	return v;
}
function iso(v: unknown, code: string): string {
	const s = text(v, code);
	if (Number.isNaN(Date.parse(s))) fail(code);
	return s;
}
function ver(o: Record<string, unknown>, code: string): void {
	if (o.version !== 1) fail(`${code}_VERSION_UNSUPPORTED`);
}
function safePath(v: unknown, code: string): string {
	const s = text(v, code, 1024);
	const segments = s.split("/");
	if (
		!s.startsWith("/") ||
		s.startsWith("//") ||
		segments.slice(1).some((segment) => !segment || segment === "." || segment === "..") ||
		unsafeChars(s)
	)
		fail(code);
	return s;
}
function relativePath(v: unknown, code: string): string {
	const s = text(v, code, 1024);
	const segments = s.split("/");
	if (
		!s ||
		s.startsWith("/") ||
		s.includes("\\") ||
		segments.some((segment) => !segment || segment === "." || segment === "..") ||
		unsafeChars(s)
	)
		fail(code);
	return s;
}
function sha(v: unknown, code: string): string {
	const s = text(v, code);
	if (!SHA40.test(s)) fail(code);
	return s;
}
function target(v: unknown, code: string): Record<string, unknown> {
	const i = obj(v, code),
		kind = text(i.kind, `${code}_KIND_INVALID`);
	if (kind === "content") {
		const x = exact(i, ["kind", "contentId", "path"], code);
		return {
			kind,
			contentId: text(x.contentId, `${code}_CONTENT_ID_INVALID`),
			path: safePath(x.path, `${code}_PATH_INVALID`),
		};
	}
	if (kind === "landing_page") {
		exact(i, ["kind", "path"], code);
		return { kind, path: safePath(i.path, `${code}_PATH_INVALID`) };
	}
	if (kind === "section") {
		const x = exact(i, ["kind", "path", "sectionId"], code);
		return {
			kind,
			path: safePath(x.path, `${code}_PATH_INVALID`),
			sectionId: text(x.sectionId, `${code}_SECTION_ID_INVALID`),
		};
	}
	if (kind === "metadata") {
		const x = exact(i, ["kind", "path", "field"], code);
		if (typeof x.field !== "string" || !["title", "description", "canonical", "schema"].includes(x.field))
			fail(`${code}_FIELD_INVALID`);
		return { kind, path: safePath(x.path, `${code}_PATH_INVALID`), field: x.field };
	}
	return fail(`${code}_KIND_INVALID`);
}
function source(v: unknown, code: string): Record<string, unknown> {
	const i = exact(v, ["repository", "branch", "path", "commitSha", "deliveryId"], code),
		repository = text(i.repository, `${code}_REPOSITORY_INVALID`),
		branch = text(i.branch, `${code}_BRANCH_INVALID`),
		p = text(i.path, `${code}_PATH_INVALID`);
	if (!REPOSITORY.test(repository)) fail(`${code}_REPOSITORY_INVALID`);
	if (!BRANCH.test(branch) || branch.includes("..")) fail(`${code}_BRANCH_INVALID`);
	const normalizedPath = relativePath(p, `${code}_PATH_INVALID`);
	const o: Record<string, unknown> = {
		repository,
		branch,
		path: normalizedPath,
		commitSha: sha(i.commitSha, `${code}_COMMIT_INVALID`),
	};
	if (i.deliveryId !== undefined) o.deliveryId = text(i.deliveryId, `${code}_DELIVERY_INVALID`);
	return o;
}
function media(v: unknown): Record<string, unknown> {
	const i = exact(
			v,
			["sourcePath", "sha256", "mimeType", "bytes", "width", "height", "alt", "emdashMediaId"],
			"CONTENT_SYNC_MEDIA_ITEM",
		),
		hash = text(i.sha256, "CONTENT_SYNC_MEDIA_HASH_INVALID"),
		sourcePath = text(i.sourcePath, "CONTENT_SYNC_MEDIA_PATH_INVALID");
	if (!SHA64.test(hash)) fail("CONTENT_SYNC_MEDIA_HASH_INVALID");
	const normalizedSourcePath = relativePath(sourcePath, "CONTENT_SYNC_MEDIA_PATH_INVALID");
	if (!MIME.test(text(i.mimeType, "CONTENT_SYNC_MEDIA_MIME_INVALID")))
		fail("CONTENT_SYNC_MEDIA_MIME_INVALID");
	if (typeof i.bytes !== "number" || !Number.isInteger(i.bytes) || i.bytes <= 0)
		fail("CONTENT_SYNC_MEDIA_BYTES_INVALID");
	const paired = (i.width === undefined) === (i.height === undefined);
	if (
		!paired ||
		(i.width !== undefined && (typeof i.width !== "number" || !Number.isInteger(i.width) || i.width <= 0)) ||
		(i.height !== undefined && (typeof i.height !== "number" || !Number.isInteger(i.height) || i.height <= 0))
	)
		fail("CONTENT_SYNC_MEDIA_DIMENSIONS_INVALID");
	const o: Record<string, unknown> = {
		sourcePath: normalizedSourcePath,
		sha256: hash,
		mimeType: i.mimeType,
		bytes: i.bytes,
		alt: text(i.alt, "CONTENT_SYNC_MEDIA_ALT_INVALID"),
	};
	if (i.width !== undefined) o.width = i.width;
	if (i.height !== undefined) o.height = i.height;
	if (i.emdashMediaId !== undefined)
		o.emdashMediaId = text(i.emdashMediaId, "CONTENT_SYNC_MEDIA_ID_INVALID");
	return o;
}
function campaign(v: unknown): Record<string, unknown> {
	const i = exact(
			v,
			["source", "medium", "campaign", "term", "content", "clickId"],
			"ANALYTICS_CAMPAIGN",
		),
		o: Record<string, unknown> = {};
	for (const k of ["source", "medium", "campaign", "term", "content", "clickId"])
		if (i[k] !== undefined) o[k] = text(i[k], `ANALYTICS_CAMPAIGN_${k.toUpperCase()}_INVALID`, 256);
	return o;
}

export function validateAnalyticsEventEnvelope(v: unknown): AnalyticsEventEnvelope {
	scan(v);
	const i = exact(
		v,
		[
			"version",
			"eventId",
			"eventName",
			"occurredAt",
			"receivedAt",
			"anonymousId",
			"sessionId",
			"path",
			"referrer",
			"contentId",
			"deploymentSha",
			"viewport",
			"campaign",
			"experiment",
			"payload",
		],
		"ANALYTICS_EVENT_ENVELOPE",
	);
	ver(i, "ANALYTICS_EVENT_ENVELOPE");
	if (
		![
			"page_view",
			"section_exposure",
			"scroll_depth",
			"cta_exposure",
			"cta_click",
			"form_start",
			"form_submit",
			"conversion",
			"revenue",
			"experiment_exposure",
		].includes(typeof i.eventName === "string" ? i.eventName : "")
	)
		fail("ANALYTICS_EVENT_NAME_INVALID");
	const o: Record<string, unknown> = {
		version: 1,
		eventId: text(i.eventId, "ANALYTICS_EVENT_ID_INVALID"),
		eventName: i.eventName,
		occurredAt: iso(i.occurredAt, "ANALYTICS_EVENT_OCCURRED_AT_INVALID"),
		anonymousId: text(i.anonymousId, "ANALYTICS_ANONYMOUS_ID_INVALID"),
		sessionId: text(i.sessionId, "ANALYTICS_SESSION_ID_INVALID"),
		path: safePath(i.path, "ANALYTICS_PATH_INVALID"),
		payload: structuredClone(obj(i.payload, "ANALYTICS_EVENT_PAYLOAD_INVALID")),
	};
	if (i.receivedAt !== undefined) o.receivedAt = iso(i.receivedAt, "ANALYTICS_RECEIVED_AT_INVALID");
	if (i.referrer !== undefined) o.referrer = text(i.referrer, "ANALYTICS_REFERRER_INVALID");
	if (i.contentId !== undefined) o.contentId = text(i.contentId, "ANALYTICS_CONTENT_ID_INVALID");
	if (i.deploymentSha !== undefined)
		o.deploymentSha = sha(i.deploymentSha, "ANALYTICS_DEPLOYMENT_SHA_INVALID");
	if (i.viewport !== undefined) {
		const x = exact(i.viewport, ["width", "height"], "ANALYTICS_VIEWPORT");
		o.viewport = {
			width: finite(x.width, "ANALYTICS_VIEWPORT_WIDTH_INVALID", 1, 10000),
			height: finite(x.height, "ANALYTICS_VIEWPORT_HEIGHT_INVALID", 1, 10000),
		};
	}
	if (i.campaign !== undefined) o.campaign = campaign(i.campaign);
	if (i.experiment !== undefined) {
		const x = exact(
			i.experiment,
			["experimentId", "variantId", "assignedAt"],
			"ANALYTICS_EXPERIMENT",
		);
		o.experiment = {
			experimentId: text(x.experimentId, "ANALYTICS_EXPERIMENT_ID_INVALID"),
			variantId: text(x.variantId, "ANALYTICS_VARIANT_ID_INVALID"),
			assignedAt: iso(x.assignedAt, "ANALYTICS_ASSIGNED_AT_INVALID"),
		};
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the normalized envelope is constructed only from runtime-validated fields above.
	return o as unknown as AnalyticsEventEnvelope;
}

export function validateContentSyncCommand(v: unknown): ContentSyncCommand {
	scan(v);
	const i = exact(
		v,
		[
			"version",
			"operation",
			"source",
			"collection",
			"contentId",
			"slug",
			"previousSlug",
			"expectedRevision",
			"publishState",
			"scheduledFor",
			"fields",
			"media",
		],
		"CONTENT_SYNC",
	);
	ver(i, "CONTENT_SYNC");
	if (typeof i.operation !== "string" || !["upsert", "rename", "unpublish", "delete"].includes(i.operation))
		fail("CONTENT_SYNC_OPERATION_INVALID");
	const fields = obj(i.fields, "CONTENT_SYNC_FIELDS_INVALID");
	for (const k of Object.keys(fields))
		if (DIRECT_KEY.test(k)) fail("CONTENT_SYNC_DIRECT_PUBLISH_FORBIDDEN");
	if (!Array.isArray(i.media)) fail("CONTENT_SYNC_MEDIA_INVALID");
	const state = i.publishState;
	if (typeof state !== "string" || !["draft", "published", "scheduled", "unpublished"].includes(state))
		fail("CONTENT_SYNC_PUBLISH_STATE_INVALID");
	const o: Record<string, unknown> = {
		version: 1,
		operation: i.operation,
		source: source(i.source, "CONTENT_SYNC_SOURCE"),
		collection: text(i.collection, "CONTENT_SYNC_COLLECTION_INVALID"),
		slug: text(i.slug, "CONTENT_SYNC_SLUG_INVALID"),
		publishState: state,
		fields: structuredClone(fields),
		media: i.media.map((x: unknown) => media(x)),
	};
	if (state === "scheduled") o.scheduledFor = iso(i.scheduledFor, "CONTENT_SYNC_SCHEDULE_REQUIRED");
	else if (i.scheduledFor !== undefined)
		o.scheduledFor = iso(i.scheduledFor, "CONTENT_SYNC_SCHEDULE_INVALID");
	for (const k of ["contentId", "previousSlug", "expectedRevision"])
		if (i[k] !== undefined) o[k] = text(i[k], `CONTENT_SYNC_${k.toUpperCase()}_INVALID`);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the normalized command is constructed only from runtime-validated fields above.
	return o as unknown as ContentSyncCommand;
}

function evidence(v: unknown): Record<string, unknown> {
	const i = exact(
		v,
		["snapshotId", "metricIds", "observation", "strength"],
		"IMPROVEMENT_PROPOSAL_EVIDENCE",
	);
	if (typeof i.strength !== "string" || !["weak", "moderate", "strong"].includes(i.strength))
		fail("IMPROVEMENT_PROPOSAL_EVIDENCE_STRENGTH_INVALID");
	return {
		snapshotId: text(i.snapshotId, "IMPROVEMENT_PROPOSAL_SNAPSHOT_ID_INVALID"),
		metricIds: strings(i.metricIds, "IMPROVEMENT_PROPOSAL_METRIC_IDS"),
		observation: text(i.observation, "IMPROVEMENT_PROPOSAL_OBSERVATION_INVALID"),
		strength: i.strength,
	};
}
export function validateImprovementProposal(v: unknown): ImprovementProposal {
	const i = exact(
		v,
		[
			"version",
			"proposalId",
			"target",
			"status",
			"diagnosis",
			"uncertainty",
			"evidence",
			"hypothesis",
			"proposedChanges",
			"expectedOutcome",
			"regressionRisks",
			"verificationPlan",
			"createdAt",
			"createdBy",
			"confidence",
			"assumptions",
			"missingEvidence",
			"evidenceRefs",
			"requiredHumanDecisions",
			"proposalType",
			"recommendedActions",
			"actionsNotRecommended",
			"opsImpact",
			"branch",
			"pullRequestUrl",
		],
		"IMPROVEMENT_PROPOSAL",
	);
	ver(i, "IMPROVEMENT_PROPOSAL");
	if (typeof i.status !== "string" || !["proposed", "approved", "rejected", "implemented", "reverted"].includes(i.status))
		fail("IMPROVEMENT_PROPOSAL_STATUS_INVALID");
	if (!Array.isArray(i.evidence) || !i.evidence.length || !Array.isArray(i.proposedChanges))
		fail("IMPROVEMENT_PROPOSAL_EVIDENCE_REQUIRED");
	const o: Record<string, unknown> = {
		version: 1,
		proposalId: text(i.proposalId, "IMPROVEMENT_PROPOSAL_ID_INVALID"),
		target: target(i.target, "IMPROVEMENT_PROPOSAL_TARGET"),
		status: i.status,
		diagnosis: text(i.diagnosis, "IMPROVEMENT_PROPOSAL_DIAGNOSIS_INVALID"),
		uncertainty: strings(i.uncertainty, "IMPROVEMENT_PROPOSAL_UNCERTAINTY", true),
		evidence: i.evidence.map((x: unknown) => evidence(x)),
		hypothesis: text(i.hypothesis, "IMPROVEMENT_PROPOSAL_HYPOTHESIS_INVALID"),
		expectedOutcome: text(i.expectedOutcome, "IMPROVEMENT_PROPOSAL_EXPECTED_OUTCOME_INVALID"),
		regressionRisks: strings(i.regressionRisks, "IMPROVEMENT_PROPOSAL_REGRESSION_RISKS"),
		verificationPlan: strings(i.verificationPlan, "IMPROVEMENT_PROPOSAL_VERIFICATION_PLAN", true),
		createdAt: iso(i.createdAt, "IMPROVEMENT_PROPOSAL_CREATED_AT_INVALID"),
		createdBy: text(i.createdBy, "IMPROVEMENT_PROPOSAL_CREATED_BY_INVALID"),
		confidence: finite(i.confidence, "IMPROVEMENT_PROPOSAL_CONFIDENCE_INVALID", 0, 1),
		assumptions: strings(i.assumptions, "IMPROVEMENT_PROPOSAL_ASSUMPTIONS"),
		missingEvidence: strings(i.missingEvidence, "IMPROVEMENT_PROPOSAL_MISSING_EVIDENCE"),
		evidenceRefs: strings(i.evidenceRefs, "IMPROVEMENT_PROPOSAL_EVIDENCE_REFS", true),
		requiredHumanDecisions: strings(
			i.requiredHumanDecisions,
			"IMPROVEMENT_PROPOSAL_HUMAN_DECISIONS",
			true,
		),
	};
	o.proposedChanges = i.proposedChanges.map((change: unknown) => {
		const x = exact(change, ["repository", "path", "summary"], "IMPROVEMENT_PROPOSAL_CHANGE");
		const summary = text(x.summary, "IMPROVEMENT_PROPOSAL_CHANGE_SUMMARY_INVALID");
		if (DIRECT_VALUE.test(summary)) fail("IMPROVEMENT_PROPOSAL_DIRECT_PUBLISH_FORBIDDEN");
		return {
			repository: text(x.repository, "IMPROVEMENT_PROPOSAL_CHANGE_REPOSITORY_INVALID"),
			path: safePath(x.path, "IMPROVEMENT_PROPOSAL_CHANGE_PATH_INVALID"),
			summary,
		};
	});
	for (const k of ["recommendedActions", "actionsNotRecommended"])
		if (i[k] !== undefined) o[k] = strings(i[k], `IMPROVEMENT_PROPOSAL_${k.toUpperCase()}`);
	if (i.proposalType !== undefined) {
		if (
			!["content", "seo", "cta", "lp", "experiment", "custom_code", "publish_plan"].includes(
				typeof i.proposalType === "string" ? i.proposalType : "",
			)
		)
			fail("IMPROVEMENT_PROPOSAL_TYPE_INVALID");
		o.proposalType = i.proposalType;
	}
	if (i.branch !== undefined) o.branch = text(i.branch, "IMPROVEMENT_PROPOSAL_BRANCH_INVALID");
	if (i.pullRequestUrl !== undefined) {
		const u = text(i.pullRequestUrl, "IMPROVEMENT_PROPOSAL_URL_INVALID");
		if (!u.startsWith("https://")) fail("IMPROVEMENT_PROPOSAL_URL_INVALID");
		o.pullRequestUrl = u;
	}
	if (i.opsImpact !== undefined) {
		const x = exact(
			i.opsImpact,
			["operationType", "operationRisk", "requiresOperationalGate", "requiresSignalCoreApproval"],
			"IMPROVEMENT_PROPOSAL_OPS_IMPACT",
		);
		if (
			typeof x.requiresOperationalGate !== "boolean" ||
			typeof x.requiresSignalCoreApproval !== "boolean"
		)
			fail("IMPROVEMENT_PROPOSAL_OPS_IMPACT_INVALID");
		if (
			![
				"content_draft",
				"content_proposal",
				"content_edit",
				"content_publish",
				"bulk_publish",
				"experiment_config",
				"tracking_config",
				"custom_code_draft",
				"custom_code_publish",
				"revalidate",
				"revalidate_paths",
				"revalidate_tags",
				"revalidate_all",
				"route_template_change",
				"schema_change",
				"deployment",
				"restore_apply",
				"incident_response",
				"quality_evaluate",
				"approval",
				"knowledge_activate",
			].includes(typeof x.operationType === "string" ? x.operationType : "")
		)
			fail("IMPROVEMENT_PROPOSAL_OPERATION_TYPE_INVALID");
		if (typeof x.operationRisk !== "string" || !["low", "medium", "high", "critical"].includes(x.operationRisk))
			fail("IMPROVEMENT_PROPOSAL_OPERATION_RISK_INVALID");
		o.opsImpact = {
			operationType: text(x.operationType, "IMPROVEMENT_PROPOSAL_OPERATION_TYPE_INVALID"),
			operationRisk: text(x.operationRisk, "IMPROVEMENT_PROPOSAL_OPERATION_RISK_INVALID"),
			requiresOperationalGate: x.requiresOperationalGate,
			requiresSignalCoreApproval: x.requiresSignalCoreApproval,
		};
	}
	scan(i);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the normalized proposal is constructed only from runtime-validated fields above.
	return o as unknown as ImprovementProposal;
}

export function validateContentSyncResult(v: unknown): ContentSyncResult {
	scan(v);
	const i = exact(
		v,
		[
			"version",
			"source",
			"status",
			"contentId",
			"revision",
			"uploadedMediaIds",
			"warnings",
			"errorCode",
			"errorMessage",
			"completedAt",
		],
		"CONTENT_SYNC_RESULT",
	);
	ver(i, "CONTENT_SYNC_RESULT");
	if (typeof i.status !== "string" || !["accepted", "skipped", "succeeded", "conflict", "failed"].includes(i.status))
		fail("CONTENT_SYNC_RESULT_STATUS_INVALID");
	const o: Record<string, unknown> = {
		version: 1,
		source: source(i.source, "CONTENT_SYNC_RESULT_SOURCE"),
		status: i.status,
		uploadedMediaIds: strings(i.uploadedMediaIds, "CONTENT_SYNC_RESULT_MEDIA_IDS"),
		warnings: strings(i.warnings, "CONTENT_SYNC_RESULT_WARNINGS"),
		completedAt: iso(i.completedAt, "CONTENT_SYNC_RESULT_COMPLETED_AT_INVALID"),
	};
	for (const k of ["contentId", "revision", "errorCode", "errorMessage"])
		if (i[k] !== undefined) o[k] = text(i[k], `CONTENT_SYNC_RESULT_${k.toUpperCase()}_INVALID`);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the normalized result is constructed only from runtime-validated fields above.
	return o as unknown as ContentSyncResult;
}

export function validateMetricSnapshot(v: unknown): MetricSnapshot {
	scan(v);
	const i = exact(
		v,
		[
			"version",
			"snapshotId",
			"target",
			"window",
			"definitions",
			"funnel",
			"custom",
			"sampleWarnings",
			"generatedAt",
			"sourceCommit",
		],
		"METRIC_SNAPSHOT",
	);
	ver(i, "METRIC_SNAPSHOT");
	const w = exact(i.window, ["from", "to"], "METRIC_SNAPSHOT_WINDOW"),
		from = iso(w.from, "METRIC_SNAPSHOT_WINDOW_FROM_INVALID"),
		to = iso(w.to, "METRIC_SNAPSHOT_WINDOW_TO_INVALID");
	if (Date.parse(to) < Date.parse(from)) fail("METRIC_SNAPSHOT_WINDOW_ORDER_INVALID");
	const f = exact(
			i.funnel,
			[
				"impressions",
				"clicks",
				"sessions",
				"pageViews",
				"sectionExposures",
				"scrollDepth",
				"ctaExposures",
				"ctaClicks",
				"formStarts",
				"conversions",
				"revenueMinor",
				"currency",
			],
			"METRIC_SNAPSHOT_FUNNEL",
		),
		funnel: Record<string, unknown> = {};
	for (const k of [
		"impressions",
		"clicks",
		"sessions",
		"pageViews",
		"ctaExposures",
		"ctaClicks",
		"formStarts",
		"conversions",
		"revenueMinor",
	])
		if (f[k] !== undefined) funnel[k] = count(f[k], `METRIC_SNAPSHOT_${k.toUpperCase()}_INVALID`);
	for (const k of [
		"sessions",
		"pageViews",
		"ctaExposures",
		"ctaClicks",
		"formStarts",
		"conversions",
	])
		if (funnel[k] === undefined) fail(`METRIC_SNAPSHOT_${k.toUpperCase()}_REQUIRED`);
	if (f.currency !== undefined)
		funnel.currency = text(f.currency, "METRIC_SNAPSHOT_CURRENCY_INVALID");
	for (const key of ["sectionExposures", "scrollDepth"] as const) {
		if (f[key] !== undefined) {
			const map = obj(f[key], `METRIC_SNAPSHOT_${key.toUpperCase()}_INVALID`);
			const entries = Object.entries(map);
			if (entries.length > 100) fail(`METRIC_SNAPSHOT_${key.toUpperCase()}_BOUNDS`);
			if (
				key === "scrollDepth" &&
				entries.some(([name]) => !["25", "50", "75", "90", "100"].includes(name))
			)
				fail("METRIC_SNAPSHOT_SCROLL_DEPTH_KEY_INVALID");
			if (key === "sectionExposures" && entries.some(([name]) => !SAFE_MAP_KEY.test(name)))
				fail("METRIC_SNAPSHOT_SECTION_KEY_INVALID");
			funnel[key] = Object.fromEntries(
				Object.entries(map).map(([name, value]) => [
					name,
					count(value, "METRIC_SNAPSHOT_COUNT_INVALID"),
				]),
			);
		}
	}
	const defs = Array.isArray(i.definitions)
		? i.definitions.map((d) => {
				const x = exact(
					d,
					["id", "label", "numerator", "denominator", "unit", "source"],
					"METRIC_SNAPSHOT_DEFINITION",
				);
				if (typeof x.unit !== "string" || !["count", "ratio", "currency", "duration", "position"].includes(x.unit))
					fail("METRIC_SNAPSHOT_DEFINITION_UNIT_INVALID");
				const o: Record<string, unknown> = {
					id: text(x.id, "METRIC_SNAPSHOT_DEFINITION_ID_INVALID"),
					label: text(x.label, "METRIC_SNAPSHOT_DEFINITION_LABEL_INVALID"),
					unit: x.unit,
					source: text(x.source, "METRIC_SNAPSHOT_DEFINITION_SOURCE_INVALID"),
				};
				for (const k of ["numerator", "denominator"])
					if (x[k] !== undefined) o[k] = text(x[k], "METRIC_SNAPSHOT_DEFINITION_REF_INVALID");
				return o;
			})
		: fail("METRIC_SNAPSHOT_DEFINITIONS_INVALID");
	const custom = obj(i.custom, "METRIC_SNAPSHOT_CUSTOM_INVALID");
	const normalizedCustom = Object.fromEntries(
		Object.entries(custom).map(([k, x]) => [
			k,
			x === null ? null : finite(x, "METRIC_SNAPSHOT_CUSTOM_VALUE_INVALID"),
		]),
	);
	const o: Record<string, unknown> = {
		version: 1,
		snapshotId: text(i.snapshotId, "METRIC_SNAPSHOT_ID_INVALID"),
		target: target(i.target, "METRIC_SNAPSHOT_TARGET"),
		window: { from, to },
		definitions: defs,
		funnel,
		custom: normalizedCustom,
		sampleWarnings: strings(i.sampleWarnings, "METRIC_SNAPSHOT_WARNINGS"),
		generatedAt: iso(i.generatedAt, "METRIC_SNAPSHOT_GENERATED_AT_INVALID"),
	};
	if (i.sourceCommit !== undefined)
		o.sourceCommit = sha(i.sourceCommit, "METRIC_SNAPSHOT_SOURCE_COMMIT_INVALID");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the normalized snapshot is constructed only from runtime-validated fields above.
	return o as unknown as MetricSnapshot;
}

export function validateExperimentRecord(v: unknown): ExperimentRecord {
	scan(v);
	const i = exact(
		v,
		[
			"version",
			"experimentId",
			"target",
			"status",
			"hypothesis",
			"primaryMetricId",
			"guardrailMetricIds",
			"variants",
			"startedAt",
			"endedAt",
			"decision",
			"decisionReason",
			"evidenceSnapshotIds",
			"sourcePullRequestUrl",
		],
		"EXPERIMENT_RECORD",
	);
	ver(i, "EXPERIMENT_RECORD");
	if (typeof i.status !== "string" || !["draft", "running", "paused", "completed", "reverted"].includes(i.status))
		fail("EXPERIMENT_RECORD_STATUS_INVALID");
	const vs = Array.isArray(i.variants) ? i.variants : fail("EXPERIMENT_RECORD_VARIANTS_REQUIRED");
	if (vs.length < 2) fail("EXPERIMENT_RECORD_VARIANTS_REQUIRED");
	const ids = new Set<string>();
	let total = 0;
	const variants = vs.map((variant) => {
		const x = exact(
				variant,
				["id", "label", "allocation", "deploymentSha"],
				"EXPERIMENT_RECORD_VARIANT",
			),
			id = text(x.id, "EXPERIMENT_RECORD_VARIANT_ID_INVALID");
		if (ids.has(id)) fail("EXPERIMENT_RECORD_VARIANT_DUPLICATE");
		ids.add(id);
		total += finite(x.allocation, "EXPERIMENT_RECORD_ALLOCATION_INVALID", Number.MIN_VALUE, 1);
		const o: Record<string, unknown> = {
			id,
			label: text(x.label, "EXPERIMENT_RECORD_VARIANT_LABEL_INVALID"),
			allocation: x.allocation,
		};
		if (x.deploymentSha !== undefined)
			o.deploymentSha = sha(x.deploymentSha, "EXPERIMENT_RECORD_DEPLOYMENT_SHA_INVALID");
		return o;
	});
	if (Math.abs(total - 1) > 1e-9) fail("EXPERIMENT_RECORD_ALLOCATION_TOTAL_INVALID");
	const o: Record<string, unknown> = {
		version: 1,
		experimentId: text(i.experimentId, "EXPERIMENT_RECORD_ID_INVALID"),
		target: target(i.target, "EXPERIMENT_RECORD_TARGET"),
		status: i.status,
		hypothesis: text(i.hypothesis, "EXPERIMENT_RECORD_HYPOTHESIS_INVALID"),
		primaryMetricId: text(i.primaryMetricId, "EXPERIMENT_RECORD_PRIMARY_METRIC_INVALID"),
		guardrailMetricIds: strings(i.guardrailMetricIds, "EXPERIMENT_RECORD_GUARDRAILS"),
		variants,
		evidenceSnapshotIds: strings(i.evidenceSnapshotIds, "EXPERIMENT_RECORD_EVIDENCE_IDS"),
	};
	for (const k of ["startedAt", "endedAt"])
		if (i[k] !== undefined) o[k] = iso(i[k], `EXPERIMENT_RECORD_${k.toUpperCase()}_INVALID`);
	if (
		i.startedAt !== undefined &&
		i.endedAt !== undefined &&
		typeof i.endedAt === "string" &&
		typeof i.startedAt === "string" &&
		Date.parse(i.endedAt) < Date.parse(i.startedAt)
	)
		fail("EXPERIMENT_RECORD_DATE_ORDER_INVALID");
	if (i.decision !== undefined) {
		if (typeof i.decision !== "string" || !["win", "loss", "inconclusive", "reverted"].includes(i.decision))
			fail("EXPERIMENT_RECORD_DECISION_INVALID");
		o.decision = i.decision;
	}
	if (i.decisionReason !== undefined)
		o.decisionReason = text(i.decisionReason, "EXPERIMENT_RECORD_DECISION_REASON_INVALID");
	if (i.sourcePullRequestUrl !== undefined) {
		const url = text(i.sourcePullRequestUrl, "EXPERIMENT_RECORD_URL_INVALID");
		if (!url.startsWith("https://")) fail("EXPERIMENT_RECORD_URL_INVALID");
		o.sourcePullRequestUrl = url;
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the normalized experiment is constructed only from runtime-validated fields above.
	return o as unknown as ExperimentRecord;
}

export function validateTraceabilityRecord(v: unknown): TraceabilityRecord {
	scan(v);
	const i = exact(
		v,
		[
			"version",
			"repository",
			"branch",
			"commitSha",
			"actor",
			"proposalId",
			"experimentId",
			"previewUrl",
			"checks",
			"approvedBy",
			"approvedAt",
		],
		"TRACEABILITY_RECORD",
	);
	ver(i, "TRACEABILITY_RECORD");
	const checks = Array.isArray(i.checks)
		? i.checks.map((check) => {
				const x = exact(check, ["name", "status", "url"], "TRACEABILITY_CHECK");
				if (typeof x.status !== "string" || !["passed", "failed", "skipped"].includes(x.status))
					fail("TRACEABILITY_CHECK_STATUS_INVALID");
				const o: Record<string, unknown> = {
					name: text(x.name, "TRACEABILITY_CHECK_NAME_INVALID"),
					status: x.status,
				};
				if (x.url !== undefined) {
					const url = text(x.url, "TRACEABILITY_CHECK_URL_INVALID");
					if (!url.startsWith("https://")) fail("TRACEABILITY_CHECK_URL_INVALID");
					o.url = url;
				}
				return o;
			})
		: fail("TRACEABILITY_RECORD_CHECKS_INVALID");
	const o: Record<string, unknown> = {
		version: 1,
		repository: text(i.repository, "TRACEABILITY_RECORD_REPOSITORY_INVALID"),
		branch: text(i.branch, "TRACEABILITY_RECORD_BRANCH_INVALID"),
		commitSha: sha(i.commitSha, "TRACEABILITY_RECORD_COMMIT_SHA_INVALID"),
		actor: text(i.actor, "TRACEABILITY_RECORD_ACTOR_INVALID"),
		checks,
	};
	for (const k of ["proposalId", "experimentId", "approvedBy"])
		if (i[k] !== undefined) o[k] = text(i[k], `TRACEABILITY_RECORD_${k.toUpperCase()}_INVALID`);
	if (i.previewUrl !== undefined) {
		const url = text(i.previewUrl, "TRACEABILITY_RECORD_PREVIEW_URL_INVALID");
		if (!url.startsWith("https://")) fail("TRACEABILITY_RECORD_PREVIEW_URL_INVALID");
		o.previewUrl = url;
	}
	if (i.approvedAt !== undefined)
		o.approvedAt = iso(i.approvedAt, "TRACEABILITY_RECORD_APPROVED_AT_INVALID");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the normalized record is constructed only from runtime-validated fields above.
	return o as unknown as TraceabilityRecord;
}
