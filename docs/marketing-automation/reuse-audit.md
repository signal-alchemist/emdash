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
| `scripts/build-content-catalog.ts` | Stable source-path/content-ID catalog used by sync planning | Contract adapted in `marketing-automation-contracts` |
| `scripts/migration/inventory-wordpress.ts` | WordPress inventory and cutover input | Reuse output contract; runtime remains in the site repo |
| `scripts/verify-editorial-media.ts` | Media manifest, editorial validation, and missing-alt checks | Port validation rules into the GitHub sync pipeline |
| `scripts/check-growth-boundaries.mjs` | Prevent analytics/growth code from leaking across architectural boundaries | Port as a fork-specific boundary check after plugin paths stabilize |
| `scripts/check-growth-port-boundary.mjs` | Enforce adapter boundary between site and growth runtime | Reuse adapter-first design |
| `scripts/check-growth-reachability.mjs` | Verify growth event routes and integration reachability | Reuse as deployment acceptance criteria |
| `scripts/check-ai-sdlc-traceability.mjs` | Require evidence and traceability for agent-authored changes | Reuse in proposal and experiment records |
| media and migration fixture tests | Deterministic fixtures for image and WordPress migration behavior | Import selected fixtures in a follow-up PR |

The first PR intentionally imports the shared data model rather than copying the CloudFlare-CMS runtime. That avoids embedding a site-specific Worker/D1 implementation into EmDash core before plugin boundaries are reviewed.

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

## What is pulled into this PR

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