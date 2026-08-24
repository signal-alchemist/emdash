# Reuse audit: Growth-OS and CloudFlare-CMS

This fork should reuse proven contracts and checks from adjacent repositories without coupling EmDash runtime code to site-specific implementations.

## Reuse policy

- Port small, stable contracts and validation patterns.
- Keep repository-specific deploy credentials, business logic, and database adapters in their original repositories.
- Prefer a typed interface and an adapter over copying a complete subsystem.
- Preserve source attribution in commits and pull-request notes when code is copied verbatim.
- Revalidate security assumptions because an EmDash plugin has different capabilities and trust boundaries from a site Worker.

## CloudFlare-CMS

The existing `signal-alchemist/CloudFlare-CMS` repository already exposes several useful implementation seams through its build and validation commands. The following are designated sources for the implementation phase:

| Existing implementation | Reuse in this fork | Status |
| --- | --- | --- |
| `scripts/lib/content-identity.ts`, `scripts/build-content-catalog.ts` | Stable source-path/content-ID validation and body-free catalog used by sync planning | Adapted in `marketing-automation-contracts`; provenance recorded below |
| `scripts/migration/inventory-wordpress.ts` | WordPress inventory and cutover input | Reuse output contract; runtime remains in the site repo |
| `scripts/verify-editorial-media.ts` | Media manifest, editorial validation, and missing-alt checks | Port validation rules into the GitHub sync pipeline |
| `scripts/check-growth-boundaries.mjs` | Prevent analytics/growth code from leaking across architectural boundaries | Port as a fork-specific boundary check after plugin paths stabilize |
| `scripts/check-growth-port-boundary.mjs` | Enforce adapter boundary between site and growth runtime | Reuse adapter-first design |
| `scripts/check-growth-reachability.mjs` | Verify growth event routes and integration reachability | Reuse as deployment acceptance criteria |
| `scripts/check-ai-sdlc-traceability.mjs` | Require evidence and traceability for agent-authored changes | Reuse in proposal and experiment records |
| media and migration fixture tests | Deterministic fixtures for image and WordPress migration behavior | Import selected fixtures in a follow-up PR |

The first PR intentionally imports the shared data model rather than copying the CloudFlare-CMS runtime. That avoids embedding a site-specific Worker/D1 implementation into EmDash core before plugin boundaries are reviewed.

## Adapted contract provenance

The content identity and catalog contract is adapted from CloudFlare-CMS commit `5c322909d41b49a5d492d50160679cfef71dda88`:

- `scripts/lib/content-identity.ts`: stable content ID, source path, revision, commit SHA, and canonical route validation.
- `scripts/build-content-catalog.ts`: public/internal catalog shapes, deterministic content ordering, and body-free entries.
- `tests/unit/content-catalog.test.ts`: body-free scope assertions and unknown content ID coverage.

The EmDash adaptation keeps `ContentId`, `GitSourceRef`, and `ContentSyncCommand.source` compatibility in `packages/marketing-automation-contracts`. It adds locale to the identity and catalog records, validates configured content roots, bounds input and error sizes, and serializes catalog fields explicitly. It does not copy Astro site configuration, filesystem traversal, or Cloudflare deployment code. The adapted tests cover invalid paths and routes, full lowercase commit SHAs, stable IDs, locale and document mismatches, bounded errors, deterministic ordering, and body-free serialization.

The media manifest contract is adapted from CloudFlare-CMS commit `5c322909d41b49a5d492d50160679cfef71dda88`:

- `scripts/lib/media-manifest.ts`: immutable media identity, supported extension/MIME mapping, duplicate handling, and deterministic serialization.
- `scripts/lib/editorial-media.ts`: bounded filename, byte, dimension, and decoded-image validation rules.
- `tests/media/manifest.test.ts`: deterministic ordering, duplicate conflict, and metadata-preservation coverage.
- `tests/media/pipeline-ingest.test.ts`: magic-byte, MIME, byte-size, dimension, and content-deduplication fixtures.

The EmDash adaptation is in `packages/marketing-automation-contracts/src/media-manifest.ts` and uses the existing `MediaSourceRef` shape. It validates lowercase SHA-256 values, safe source paths, supported image extensions and MIME types, bounded bytes/dimensions/pixel count/alt text, optional magic bytes, exact duplicate collapse, conflicting duplicate rejection, and byte-stable metadata serialization. It does not copy Sharp, R2, filesystem traversal, object-key policies, network fetching, or secrets.

## Growth-OS

`signal-alchemist/Growth-OS` is the candidate source for experiment lifecycle and decision-record semantics. The shared contracts in this PR adopt the reusable domain vocabulary:

- target;
- evidence window;
- metric definition;
- hypothesis;
- exposure;
- outcome;
- decision;
- win, loss, inconclusive, and reverted states;
- source commit and deployment traceability.

The implementation phase should compare the exact Growth-OS schemas and persistence APIs before copying code. Database and orchestration code should remain behind adapters because Growth-OS and EmDash have different runtime, permission, and retention requirements.

For Growth-OS Issue #12, the plugin uses only the source vocabulary and normalized snapshot boundary; it does not copy provider clients, event persistence, or site runtime. The pinned checkout is `8b1eeabce078f3858fad3d2557f25c12b01ec975`. The vocabulary sources are `apps/web/modules/analytics/gsc-import.ts` (`a819dba5e21144c22dc9c87a01c8f8e6fdf0bf13`), `apps/web/modules/analytics/ga4-import.ts` (`a819dba5e21144c22dc9c87a01c8f8e6fdf0bf13`), `apps/web/modules/analytics/funnel-snapshots.ts` (`e9d7fd73d6d2368e2ceaa738a13e399b9fdc1cdb`), `apps/web/modules/analytics/experiment-registry.ts` (`73620edca289e9e918aae8fa103c7a03ac424786`), `apps/web/modules/analytics/business-events.ts` (`b264e7567cbc4472a1dfd1e1c4a232599f460274`), `apps/web/modules/analytics/revenue-events.ts` (`13843987a6e3a430dcc77e0807b4b1d3d2950e0b`), `apps/web/modules/analytics/funnel-events.ts` (`2ea2992f09af7b130ddf4dd70255f79b400eb7d7`), and `apps/web/modules/analytics/metric-registry.ts` (`bcb67ab5e4130c069fe56a34cf31eae2e2c9f5a6`). The adapted boundary is `packages/plugins/sa-content-insights/src/snapshot-contract.ts`; its pure `adaptSourceRow` dispatch normalizes concrete GSC, GA4, first-party funnel, experiment, and CRM/revenue aggregate rows before the separate exact envelope path, and stores normalized, body-free envelopes.

## What is pulled into this PR

The GSC adapter's clicks-to-sessions/pageViews fields are an explicitly named landing-proxy formula for content-level correlation, not a claim that Search Console clicks are analytics sessions or page views.

The shared `marketing-automation-contracts` package consolidates the portable parts needed by all three plugins:

- Git source identity and revision-safe sync commands;
- media identity and hash metadata;
- first-party analytics event envelope;
- campaign and experiment attribution;
- metric snapshots;
- evidence-backed improvement proposals;
- experiment lifecycle and decision records.

## Follow-up extraction checklist

- [ ] Diff the shared types against current Growth-OS experiment schemas.
- [ ] Import CloudFlare-CMS content-catalog fixtures and preserve their IDs.
- [ ] Port media validation fixtures and hash/dedup behavior.
- [ ] Port WordPress inventory fixture coverage.
- [ ] Add a boundary checker that forbids raw analytics storage in editorial plugins.
- [ ] Add AI-SDLC traceability validation for every improvement proposal.
- [ ] Record copied-file origins and upstream commit SHAs in the implementation PR.
