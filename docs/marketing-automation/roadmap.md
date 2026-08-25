# Implementation roadmap

## P0 — architecture and contract review

- Review sandboxed/native plugin boundaries.
- Compare shared contracts with Growth-OS and CloudFlare-CMS.
- Confirm EmDash API surfaces for public routes, settings, media upload, revisions, and admin Block Kit.
- Define privacy, consent, retention, and deletion requirements.

**Exit criteria:** Codex review issue resolved, contract changes merged, and no unresolved capability/security blockers.

## P1 — GitHub content and media synchronization

- Signed GitHub webhook ingestion.
- Merge-only event filtering and repository allowlist.
- Source catalog and frontmatter validation.
- Media hashing, upload deduplication, and alt validation.
- Create/update with revision conflict detection.
- Explicit publish, unpublish, rename, and deletion policy.
- Delivery audit page and retry controls.

**Exit criteria:** repeated delivery is idempotent; a stale revision never overwrites a manual edit; article plus images can be previewed, merged, and published end to end.

## P2 — first-party analytics collector

- Versioned browser client injected by the native plugin.
- Batched page, section, scroll, CTA, form, conversion, and experiment events.
- Anonymous/session identity with consent-aware persistence.
- Rate limiting, payload limits, bot filtering, and schema validation.
- Durable forwarding to a D1/warehouse service.
- Data retention and deletion jobs.

**Exit criteria:** events are attributable to path, content ID, campaign, deployment, and experiment without collecting form values or unnecessary PII.

## P3 — content insights

- Import normalized metric snapshots.
- Show query/CTR, scroll, CTA, conversion, and revenue summaries by content ID.
- Attach evidence and experiment history to editorial content.
- Export machine-readable context for improvement agents.

**Exit criteria:** an editor can identify where a funnel loses users and trace every metric to a time window and definition.

## P4 — LP experiment workflow

- Astro LP templates under `/lp/*` in the consuming site repository.
- Stable edge variant assignment.
- Exposure and conversion attribution.
- Branch/preview generation for proposed variants.
- Winner, loser, inconclusive, rollback, and holdout decisions.

**Exit criteria:** an LP improvement is locally previewed, reviewed in a PR, deployed, measured, and recorded without changing production autonomously.

## P5 — WordPress migration and cutover

- WordPress content/media inventory.
- Content-type, taxonomy, author, SEO, URL, and redirect mapping.
- Media integrity and attachment relationship verification.
- Astro theme port and replacement-plugin inventory.
- Dual-run, redirect, rollback, and post-cutover checks.

**Exit criteria:** content count, URL mapping, media integrity, canonical metadata, and redirects pass deterministic checks before DNS/route cutover.

## Non-goals for the foundation PR

- Building a Clarity/PostHog-equivalent session replay product.
- Automatically merging agent changes.
- Storing unlimited raw analytics inside EmDash plugin storage.
- Porting WordPress PHP themes or plugins automatically.
- Shipping production credentials or Cloudflare bindings in the fork.