/** Stable error returned when a plugin write's revision no longer matches. */
export class PluginRevisionConflictError extends Error {
	readonly code = "CONFLICT" as const;
	readonly status = 409 as const;

	constructor(message = "Content has been modified since last read (version conflict)") {
		super(message);
		this.name = "PluginRevisionConflictError";
	}
}
