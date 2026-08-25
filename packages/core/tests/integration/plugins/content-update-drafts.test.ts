import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { createContentAccessWithWrite } from "../../../src/plugins/context.js";
import { PluginRevisionConflictError } from "../../../src/plugins/errors.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createPostFixture } from "../../utils/fixtures.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function portableText(text: string) {
	return [
		{
			_type: "block",
			style: "normal",
			children: [{ _type: "span", text }],
		},
	];
}

const LIVE_BODY = portableText("Live body");
const DRAFT_BODY = portableText("Draft body");
const CONCURRENT_BODY = portableText("Concurrent body");

describeEachDialect("plugin content updates with revisions", (dialect) => {
	let ctx: DialectTestContext;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		contentRepo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPublishedPost() {
		const created = await contentRepo.create(
			createPostFixture({ status: "draft", data: { title: "Live title", content: LIVE_BODY } }),
		);
		return contentRepo.publish("post", created.id);
	}

	it("stages an update when the published entry has no draft and promotes it on publish", async () => {
		const published = await createPublishedPost();
		const access = createContentAccessWithWrite(ctx.db);

		const result = await access.update("post", published.id, { title: "Plugin title" });
		const staged = await contentRepo.findById("post", published.id);

		expect(result.data).toEqual({ title: "Plugin title", content: LIVE_BODY });
		expect(result.updatedAt).toBe(published.updatedAt);
		expect(staged).toMatchObject({
			data: { title: "Live title", content: LIVE_BODY },
			liveRevisionId: published.liveRevisionId,
			version: published.version + 1,
		});
		expect(staged?.draftRevisionId).not.toBeNull();

		const promoted = await contentRepo.publish("post", published.id);
		expect(promoted.data).toEqual({ title: "Plugin title", content: LIVE_BODY });
		expect(promoted.draftRevisionId).toBeNull();
		expect(promoted.liveRevisionId).toBe(staged?.draftRevisionId);
	});

	it("returns a revision token and rejects stale plugin updates", async () => {
		const created = await contentRepo.create(
			createPostFixture({ status: "draft", data: { title: "Original" } }),
		);
		const access = createContentAccessWithWrite(ctx.db);

		const current = await access.get("post", created.id);
		expect(current?.revision).toBeTruthy();
		const beforeStaleWrite = await contentRepo.findById("post", created.id);

		const updated = await access.update(
			"post",
			created.id,
			{ title: "First" },
			{
				expectedRevision: current!.revision,
			},
		);
		expect(updated.revision).toBeTruthy();
		expect(updated.revision).not.toBe(current!.revision);
		const afterFreshWrite = await contentRepo.findById("post", created.id);

		await expect(
			access.update(
				"post",
				created.id,
				{ title: "Stale" },
				{
					expectedRevision: current!.revision,
				},
			),
		).rejects.toBeInstanceOf(PluginRevisionConflictError);
		await expect(
			access.update(
				"post",
				created.id,
				{ title: "Still stale" },
				{ expectedRevision: current!.revision },
			),
		).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
		const afterStaleWrite = await contentRepo.findById("post", created.id);
		expect(afterStaleWrite).toMatchObject({
			data: { title: "First" },
			slug: afterFreshWrite?.slug,
			status: afterFreshWrite?.status,
			liveRevisionId: afterFreshWrite?.liveRevisionId,
			draftRevisionId: afterFreshWrite?.draftRevisionId,
			version: afterFreshWrite?.version,
		});
		expect(afterStaleWrite?.updatedAt).toBe(afterFreshWrite?.updatedAt);
		expect(afterStaleWrite?.version).toBe(beforeStaleWrite!.version + 1);
	});

	it("supports revision-safe plugin rename and publish", async () => {
		const created = await contentRepo.create(
			createPostFixture({ status: "draft", data: { title: "Rename me" }, slug: "before" }),
		);
		const access = createContentAccessWithWrite(ctx.db);
		const current = await access.get("post", created.id);

		const renamed = await access.update(
			"post",
			created.id,
			{},
			{
				expectedRevision: current!.revision,
				slug: "after",
			},
		);
		expect(renamed.slug).toBe("before");

		const published = await access.publish("post", created.id, {
			expectedRevision: renamed.revision,
		});
		expect(published.status).toBe("published");
		expect(published.slug).toBe("after");
	});

	it("rejects stale plugin unpublish without clearing the live revision", async () => {
		const published = await createPublishedPost();
		const access = createContentAccessWithWrite(ctx.db);
		const current = await access.get("post", published.id);

		await access.update("post", published.id, { title: "Manual edit" });
		await expect(
			access.unpublish("post", published.id, { expectedRevision: current!.revision }),
		).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
		expect((await contentRepo.findById("post", published.id))?.status).toBe("published");
	});

	it("returns a typed conflict when publish observes a stale token", async () => {
		const created = await contentRepo.create(
			createPostFixture({ status: "draft", data: { title: "Publish race" } }),
		);
		const access = createContentAccessWithWrite(ctx.db);
		const current = await access.get("post", created.id);
		await access.update("post", created.id, { title: "Changed" });

		await expect(
			access.publish("post", created.id, { expectedRevision: current!.revision }),
		).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
	});

	it("unpublishes with a matching token and creates the draft atomically", async () => {
		const published = await createPublishedPost();
		const access = createContentAccessWithWrite(ctx.db);
		const current = await access.get("post", published.id);

		const unpublished = await access.unpublish("post", published.id, {
			expectedRevision: current!.revision,
		});
		expect(unpublished.status).toBe("draft");
		expect(unpublished.revision).not.toBe(current!.revision);
		const row = await contentRepo.findById("post", published.id);
		expect(row).toMatchObject({ status: "draft", liveRevisionId: null });
		expect(row?.draftRevisionId).toBeTruthy();
		expect(row?.version).toBe(published.version + 1);
	});

	it("cleans up a provisional draft when a fenced repository unpublish conflicts", async () => {
		const published = await createPublishedPost();
		const before = await contentRepo.findById("post", published.id);
		await expect(
			contentRepo.unpublish("post", published.id, {
				version: before!.version - 1,
				liveRevisionId: before!.liveRevisionId,
				draftRevisionId: before!.draftRevisionId,
			}),
		).rejects.toThrow(/conflict/i);
		const after = await contentRepo.findById("post", published.id);
		expect(after).toMatchObject({
			status: "published",
			version: before!.version,
			liveRevisionId: before!.liveRevisionId,
			draftRevisionId: before!.draftRevisionId,
		});
	});

	it("merges a partial update into an existing draft", async () => {
		const published = await createPublishedPost();
		const revisionRepo = new RevisionRepository(ctx.db);
		const draft = await revisionRepo.create({
			collection: "post",
			entryId: published.id,
			data: { title: "Draft title", content: DRAFT_BODY },
		});
		await contentRepo.setDraftRevision("post", published.id, draft.id);
		const beforePluginUpdate = await contentRepo.findById("post", published.id);
		const access = createContentAccessWithWrite(ctx.db);

		const result = await access.update("post", published.id, { title: "Plugin title" });
		const staged = await contentRepo.findById("post", published.id);

		expect(result.data).toEqual({ title: "Plugin title", content: DRAFT_BODY });
		expect(staged?.data).toEqual({ title: "Live title", content: LIVE_BODY });
		expect(staged?.version).toBe(beforePluginUpdate!.version + 1);
		expect(staged?.draftRevisionId).not.toBe(draft.id);

		const promoted = await contentRepo.publish("post", published.id);
		expect(promoted.data).toEqual({ title: "Plugin title", content: DRAFT_BODY });
	});

	it("leaves the published data intact when the plugin draft is discarded", async () => {
		const published = await createPublishedPost();
		const access = createContentAccessWithWrite(ctx.db);

		await access.update("post", published.id, { title: "Discarded plugin title" });
		const discarded = await contentRepo.discardDraft("post", published.id);

		expect(discarded.data).toEqual({ title: "Live title", content: LIVE_BODY });
		expect(discarded.liveRevisionId).toBe(published.liveRevisionId);
		expect(discarded.draftRevisionId).toBeNull();
	});

	it("keeps revisionless updates as direct writes that survive publication", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "plain_post", label: "Plain posts", supports: [] });
		await registry.createField("plain_post", { slug: "title", label: "Title", type: "string" });
		await registry.createField("plain_post", { slug: "content", label: "Content", type: "string" });
		const created = await contentRepo.create({
			type: "plain_post",
			slug: "plain-post",
			status: "published",
			data: { title: "Original title", content: "Original body" },
		});
		const access = createContentAccessWithWrite(ctx.db);

		const result = await access.update("plain_post", created.id, { title: "Plugin title" });
		const updated = await contentRepo.findById("plain_post", created.id);

		expect(result.data).toEqual({ title: "Plugin title", content: "Original body" });
		expect(updated).toMatchObject({
			data: { title: "Plugin title", content: "Original body" },
			draftRevisionId: null,
			version: created.version + 1,
		});

		const republished = await contentRepo.publish("plain_post", created.id, undefined, false);
		expect(republished.data).toEqual({ title: "Plugin title", content: "Original body" });
	});

	it("merges concurrent partial updates and advances the version once per write", async () => {
		const published = await createPublishedPost();
		const access = createContentAccessWithWrite(ctx.db);

		await Promise.all([
			access.update("post", published.id, { title: "Concurrent title" }),
			access.update("post", published.id, { content: CONCURRENT_BODY }),
		]);

		const staged = await contentRepo.findById("post", published.id);
		expect(staged?.version).toBe(published.version + 2);
		expect(staged?.data).toEqual({ title: "Live title", content: LIVE_BODY });
		expect(staged?.draftRevisionId).not.toBeNull();

		const promoted = await contentRepo.publish("post", published.id);
		expect(promoted.data).toEqual({
			title: "Concurrent title",
			content: CONCURRENT_BODY,
		});
	});
});
