const MAX_BODY_BYTES = 1_000_000;
const MAX_HEADER_BYTES = 512;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const DELIVERY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const DECIMAL_LENGTH = /^\d{1,10}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,120}$/;
const MAX_POLICY_ENTRIES = 64;

function isBranchRef(value: string): boolean {
	if (!BRANCH_REF.test(value)) return false;
	return value.slice("refs/heads/".length).split("/").every((segment) =>
		segment.length > 0 && segment !== "." && segment !== "..",
	);
}

export interface GithubContentSyncWebhookConfig {
	webhookSecretEnv: string;
	repositories: readonly string[];
	branches: readonly string[];
	events: readonly string[];
}

export interface GithubContentSyncDispatch {
	deliveryId: string;
	event: "pull_request";
	repository: string;
	branch: string;
	commitSha: string;
	actorId: string;
	pullRequestNumber: number;
	filesUrl: string;
}

export type GithubWebhookErrorCode =
	| "GITHUB_SYNC_NOT_CONFIGURED"
	| "GITHUB_SYNC_BODY_INVALID"
	| "GITHUB_SYNC_SIGNATURE_INVALID"
	| "GITHUB_SYNC_DELIVERY_INVALID"
	| "GITHUB_SYNC_EVENT_INVALID"
	| "GITHUB_SYNC_POLICY_REJECTED"
	| "GITHUB_SYNC_PAYLOAD_INVALID"
	| "GITHUB_SYNC_REPLAY_BUSY";

export class GithubContentSyncWebhookError extends Error {
	readonly code: GithubWebhookErrorCode;
	readonly status: 400 | 401 | 413 | 503;

	constructor(code: GithubWebhookErrorCode, status: 400 | 401 | 413 | 503 = 400) {
		super(code);
		this.name = "GithubContentSyncWebhookError";
		this.code = code;
		this.status = status;
	}
}

export class GithubContentSyncReplayGuard {
	private readonly completed = new Set<string>();
	private readonly inFlight = new Map<string, Promise<void>>();

	constructor(private readonly maxInFlight = 1024) {}

	async run(deliveryId: string, dispatch: () => Promise<void>): Promise<boolean> {
		if (this.completed.has(deliveryId)) return false;
		const current = this.inFlight.get(deliveryId);
		if (current) {
			await current;
			return false;
		}
		if (this.inFlight.size >= this.maxInFlight)
			throw new GithubContentSyncWebhookError("GITHUB_SYNC_REPLAY_BUSY", 503);
		const promise = dispatch();
		this.inFlight.set(deliveryId, promise);
		try {
			await promise;
			this.completed.add(deliveryId);
			while (this.completed.size > 1024)
				this.completed.delete(this.completed.values().next().value!);
			return true;
		} finally {
			this.inFlight.delete(deliveryId);
		}
	}
}

function fail(code: GithubWebhookErrorCode, status: 400 | 401 | 413 | 503 = 400): never {
	throw new GithubContentSyncWebhookError(code, status);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
	return difference === 0;
}

function decodeHex(value: string): Uint8Array | null {
	if (!SHA256_HEX.test(value)) return null;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1)
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	return bytes;
}

async function verifySignature(
	body: Uint8Array,
	signature: string,
	secret: string,
): Promise<boolean> {
	if (signature.length > MAX_HEADER_BYTES || !signature.startsWith("sha256=")) return false;
	const expected = decodeHex(signature.slice("sha256=".length));
	if (!expected) return false;
	const key = await globalThis.crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const actual = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, body));
	return constantTimeEqual(actual, expected);
}

async function readBody(request: Request): Promise<Uint8Array> {
	const declaredLength = request.headers.get("content-length");
	if (
		declaredLength &&
		(!DECIMAL_LENGTH.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
	)
		fail("GITHUB_SYNC_BODY_INVALID", 413);
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const buffer = new Uint8Array(MAX_BODY_BYTES + 1);
	let length = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > MAX_BODY_BYTES) {
				await reader.cancel();
				fail("GITHUB_SYNC_BODY_INVALID", 413);
			}
			buffer.set(next.value, length - next.value.byteLength);
		}
	} finally {
		reader.releaseLock();
	}
	return buffer.slice(0, length);
}

function textHeader(request: Request, name: string): string {
	const value = request.headers.get(name)?.trim();
	if (!value || new TextEncoder().encode(value).length > MAX_HEADER_BYTES)
		fail("GITHUB_SYNC_BODY_INVALID");
	return value;
}

export async function verifyGithubContentSyncWebhook(
	request: Request,
	config: GithubContentSyncWebhookConfig | undefined,
	secret: string | undefined,
): Promise<GithubContentSyncDispatch> {
	if (!config || !secret) fail("GITHUB_SYNC_NOT_CONFIGURED", 401);
	if (
		!ENV_NAME.test(config.webhookSecretEnv) ||
		config.repositories.length === 0 ||
		config.branches.length === 0 ||
		!config.events ||
		config.events.length === 0 ||
		config.repositories.length > MAX_POLICY_ENTRIES ||
		config.branches.length > MAX_POLICY_ENTRIES ||
		config.events.length > MAX_POLICY_ENTRIES ||
		config.repositories.some((repository) => repository.length > 200 || !REPOSITORY_NAME.test(repository)) ||
		config.branches.some((branch) => branch.length > 128 || !isBranchRef(branch)) ||
		config.events.some((event) => event !== "pull_request")
	)
		fail("GITHUB_SYNC_NOT_CONFIGURED", 401);
	if (request.method !== "POST") fail("GITHUB_SYNC_BODY_INVALID");
	const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") fail("GITHUB_SYNC_BODY_INVALID");
	const body = await readBody(request);
	const signature = textHeader(request, "x-hub-signature-256");
	if (!(await verifySignature(body, signature, secret))) fail("GITHUB_SYNC_SIGNATURE_INVALID", 401);

	const deliveryId = textHeader(request, "x-github-delivery");
	if (!DELIVERY_ID.test(deliveryId)) fail("GITHUB_SYNC_DELIVERY_INVALID");
	const eventName = textHeader(request, "x-github-event");
	if (eventName !== "pull_request" || (config.events && !config.events.includes("pull_request")))
		fail("GITHUB_SYNC_EVENT_INVALID");
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		fail("GITHUB_SYNC_PAYLOAD_INVALID");
	}
	if (!payload || typeof payload !== "object") fail("GITHUB_SYNC_PAYLOAD_INVALID");
	const value = payload as Record<string, unknown>;
	const repository = value.repository;
	const pullRequest = value.pull_request;
	const sender = value.sender;
	const action = value.action;
	if (
		action !== "closed" ||
		!pullRequest ||
		typeof pullRequest !== "object" ||
		(pullRequest as Record<string, unknown>).merged !== true
	)
		fail("GITHUB_SYNC_POLICY_REJECTED");
	if (
		!repository ||
		typeof repository !== "object" ||
		typeof (repository as Record<string, unknown>).full_name !== "string"
	)
		fail("GITHUB_SYNC_PAYLOAD_INVALID");
	const repositoryName = (repository as Record<string, unknown>).full_name as string;
	if (!config.repositories.includes(repositoryName)) fail("GITHUB_SYNC_POLICY_REJECTED");
	const base = (pullRequest as Record<string, unknown>).base;
	const branchName =
		base && typeof base === "object" ? (base as Record<string, unknown>).ref : undefined;
	const branch = typeof branchName === "string" ? `refs/heads/${branchName}` : "";
	if (!config.branches.includes(branch)) fail("GITHUB_SYNC_POLICY_REJECTED");
	const commitSha = (pullRequest as Record<string, unknown>).merge_commit_sha;
	const number = (pullRequest as Record<string, unknown>).number;
	if (
		typeof commitSha !== "string" ||
		!COMMIT_SHA.test(commitSha) ||
		!Number.isSafeInteger(number) ||
		number < 1 ||
		!sender ||
		typeof sender !== "object" ||
		!Number.isSafeInteger((sender as Record<string, unknown>).id) ||
		((sender as Record<string, unknown>).id as number) < 1
	)
		fail("GITHUB_SYNC_PAYLOAD_INVALID");
	return {
		deliveryId,
		event: "pull_request",
		repository: repositoryName,
		branch,
		commitSha: commitSha.toLowerCase(),
		actorId: String((sender as Record<string, unknown>).id),
		pullRequestNumber: number,
		filesUrl: `https://api.github.com/repos/${repositoryName}/pulls/${number}/files`,
	};
}
