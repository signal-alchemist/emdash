# Architecture

## 1. Release model

Git is the reviewable source of truth; EmDash and Cloudflare are release targets.

```text
local authoring / agent branch
        |
        v
article + images + LP code + experiment record
        |
        v
local preview and automated checks
        |
        v
GitHub pull request
        |
        v
human approval and merge
        |
        +-----------------------------+
        |                             |
        v                             v
EmDash content/media sync       Cloudflare Worker deploy
        |                             |
        +--------------+--------------+
                       v
             analytics normalization
                       |
                       v
            evidence-backed proposal
                       |
                       v
                 new pull request
```

The system intentionally avoids direct autonomous writes to production. Emergency manual edits in EmDash are detected through revision checks and surfaced as sync conflicts instead of being overwritten.

## 2. Article and media flow

Recommended repository shape for a consuming site:

```text
content/
  posts/<slug>.md
  pages/<slug>.md
assets/
  posts/<slug>/hero.webp
  posts/<slug>/diagram.webp
experiments/
  <target>/<experiment-id>.md
```

On merge:

1. Determine changed, renamed, and deleted source files.
2. Validate frontmatter, schema, links, image dimensions, alt text, and content IDs.
3. Hash media and upload only missing assets.
4. Resolve uploaded media IDs into the content payload.
5. Read the current EmDash revision.
6. Create or update the entry with an expected revision.
7. Publish only when the source explicitly requests publication.
8. Store source path, commit SHA, delivery ID, EmDash content ID, revision, and result.

Required guarantees:

- GitHub delivery IDs and source commit SHAs are idempotency keys.
- A retry never creates duplicate content or media.
- A revision mismatch fails closed and creates a reviewable conflict.
- Deletion and rename behavior is explicit; source deletion must not silently destroy production content.
- Webhook signatures are verified before any content or media capability is used.

## 3. Landing-page flow

LPs are code, not ordinary CMS documents. They should remain in the consuming Astro application and be deployed through Cloudflare Workers Static Assets.

```text
example.com/             EmDash/Astro content site
example.com/blog/*       EmDash article routes
example.com/lp/*         Astro LP bundle on Cloudflare Workers
example.com/api/events/* first-party collection endpoint
```

A Worker route can assign a stable experiment variant and persist it in a first-party cookie. The variant must be included in exposure, CTA, form, conversion, and revenue events. The same path can therefore be used for advertising while retaining one origin for attribution and measurement.

## 4. Analytics model

Raw browser events and imported platform data are normalized outside EmDash plugin storage. Suggested sources:

- first-party page, section, scroll, CTA, form, and conversion events;
- ad campaign cost and click data;
- Search Console query, impression, position, and click data;
- analytics sessions and landing-page data;
- CRM or order revenue outcomes;
- EmDash content and revision metadata;
- GitHub deployment and experiment metadata.

The normalized funnel is:

```text
query/ad impression
  -> landing
  -> section exposure
  -> CTA exposure
  -> CTA click
  -> form start
  -> conversion
  -> revenue
```

Only aggregates and decision-ready snapshots are copied into `sa-content-insights` for editorial use.

## 5. Improvement loop

An improvement proposal must contain:

- target content, LP, section, or metadata;
- evidence window and metric definitions;
- diagnosis and uncertainty;
- falsifiable hypothesis;
- proposed file changes;
- expected upside and regression risks;
- local/preview verification plan;
- experiment or observation period;
- final decision: win, loss, inconclusive, or reverted.

The agent may create a branch and pull request, but it may not merge or publish without the configured human gate.

## 6. Plugin boundaries

### `sa-github-content-sync` — sandboxed

Needs content/media capabilities and allowlisted GitHub hosts. It owns synchronization state, delivery audit records, and conflict reports. It does not own long-term analytics.

### `sa-content-insights` — sandboxed

Owns metric snapshots, experiment summaries, and improvement proposals shown in EmDash admin. It reads content identifiers but does not inject visitor scripts.

### `sa-analytics-collector` — native

Browser instrumentation requires page-fragment/script integration, which is native-only in EmDash. The plugin should be intentionally small: inject a versioned client, accept batched events, apply privacy controls, and forward durable storage to a dedicated Cloudflare service.

## 7. WordPress migration

The migration target preserves content semantics rather than PHP runtime behavior:

- posts and pages;
- custom post types mapped to EmDash content types;
- taxonomies and term assignments;
- media assets and attachment relationships;
- canonical URLs, redirects, slugs, dates, authors, and SEO metadata.

WordPress themes are ported to Astro, and WordPress plugins are either replaced by EmDash plugins or retired. A migration inventory and redirect manifest are release blockers before cutover.

## 8. Security and privacy

- Verify `X-Hub-Signature-256` with a secret stored outside Git.
- Use least-privilege EmDash capabilities and fixed network allowlists.
- Never place API keys, webhook secrets, or analytics credentials in content files.
- Minimize event payloads; do not collect free-form form values or unnecessary PII.
- Apply consent and retention policies before enabling replay-like behavior.
- Rate-limit and batch public collection routes.
- Record every automated production mutation with source commit and actor.
- Treat analytics conclusions as uncertain when sample size or attribution quality is insufficient.