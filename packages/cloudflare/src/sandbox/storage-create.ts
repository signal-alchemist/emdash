export interface D1StorageCreateStatement {
	bind(...values: unknown[]): D1StorageCreateStatement;
	run(): Promise<{ meta?: { changes?: number | bigint | null | undefined } }>;
}

export interface D1StorageCreateDatabase {
	prepare(sql: string): D1StorageCreateStatement;
}

export function assertStorageCollectionDeclared(collection: string, declared: readonly string[]): void {
	if (!declared.includes(collection)) throw new Error(`Storage collection not declared: ${collection}`);
}

export async function storageCreate(
	db: D1StorageCreateDatabase,
	pluginId: string,
	collection: string,
	id: string,
	data: unknown,
): Promise<boolean> {
	const result = await db
		.prepare(
			"INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(plugin_id, collection, id) DO NOTHING",
		)
		.bind(pluginId, collection, id, JSON.stringify(data))
		.run();
	return Number(result.meta?.changes ?? 0) > 0;
}
