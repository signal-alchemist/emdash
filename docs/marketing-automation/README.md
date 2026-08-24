# EmDash marketing automation foundation

This directory defines the foundation for using the EmDash fork as the production CMS in a Git-reviewed publishing and growth-optimization system.

## Product goal

Build a workflow in which articles, media, landing pages, analytics, and improvement proposals are managed as reviewable changes:

1. An author or agent edits content, images, or LP code locally.
2. The completed page is previewed locally and in a pull request.
3. A human approves and merges the change.
4. Articles and media are synchronized to EmDash; LP code is deployed to Cloudflare Workers.
5. Search, ad, behavior, CTA, form, conversion, and revenue signals are normalized.
6. Agents create evidence-backed improvement proposals as new branches and pull requests.

Production content must not be changed directly by an autonomous agent. Git review is the release gate.

## Deliberate boundaries

- **EmDash:** WordPress migration target, article/page CMS, media library, editorial administration.
- **GitHub:** source of truth for reviewed article sources, generated media, LP code, experiments, and decision history.
- **Cloudflare Workers:** delivery of `/lp/*`, experiment assignment, event collection, and integration APIs.
- **Analytics store:** durable raw and normalized event data. EmDash plugin storage should contain operational state and aggregates, not an unlimited raw event warehouse.
- **Agents:** diagnosis and change proposals. Humans retain merge and release authority.

## Planned packages

| Package | Format | Responsibility |
| --- | --- | --- |
| `sa-github-content-sync` | Sandboxed plugin | Idempotent GitHub-to-EmDash article/media synchronization and audit state |
| `sa-content-insights` | Sandboxed plugin | Article-level metric snapshots, experiment history, and improvement proposals in EmDash admin |
| `sa-analytics-collector` | Native plugin | First-party browser instrumentation and collection endpoint wiring |
| `marketing-automation-contracts` | Shared TypeScript package | Stable event, sync, experiment, and improvement contracts |

See [architecture.md](./architecture.md), [reuse-audit.md](./reuse-audit.md), and [roadmap.md](./roadmap.md).