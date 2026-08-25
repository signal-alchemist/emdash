export class BoundedBodyError extends Error {
	readonly code = "PLUGIN_BODY_INVALID";
	readonly status = 413;
	constructor() {
		super("Bounded plugin request body is invalid");
		this.name = "BoundedBodyError";
	}
}
const METHODS = new Set(["POST", "PUT", "PATCH"]);
const DECIMAL = /^\d+$/;
export async function readBoundedJson(request: Request, max: number): Promise<unknown> {
	if (!METHODS.has(request.method.toUpperCase())) return undefined;
	const encoding = request.headers.get("content-encoding")?.trim();
	if (encoding && encoding.toLowerCase() !== "identity") throw new BoundedBodyError();
	const declared = request.headers.get("content-length");
	if (
		declared &&
		(!DECIMAL.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > max)
	)
		throw new BoundedBodyError();
	if (!request.body) throw new BoundedBodyError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > max) {
				await reader.cancel();
				throw new BoundedBodyError();
			}
			chunks.push(next.value);
		}
	} catch (error) {
		if (error instanceof BoundedBodyError) throw error;
		await reader.cancel().catch(() => undefined);
		throw new BoundedBodyError();
	} finally {
		reader.releaseLock();
	}
	if (declared && Number(declared) !== length) throw new BoundedBodyError();
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new BoundedBodyError();
	}
}
