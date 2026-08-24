# `sa-analytics-collector`

`sa-analytics-collector` is a native EmDash plugin for first-party, consent-gated browser analytics.

## Runtime behavior

- The `page:fragments` hook contributes one versioned body-end bootstrap on public content pages.
- Admin, draft, preview, and non-content pages receive no fragment.
- The bootstrap requires the host page to provide `globalThis.__EMDASH_CONSENT__`. It does not create an identifier, call the context provider, install a browser listener, start a timer, queue an event, or send a request until the receipt is granted, valid, and unexpired.
- The client validates every event with `@signal-alchemist/marketing-automation-contracts` before enqueueing. It accepts only the ten event-specific payloads from that contract.
- The queue is memory-only. The plugin does not write raw events to EmDash plugin storage.
- The default forwarding endpoint is a same-origin relative path. The client rejects absolute, credential-bearing, query-bearing, or fragment-bearing endpoints.
- Referrers are reduced to same-origin paths. Cross-origin referrers are omitted.

Session replay, DOM snapshots, arbitrary form values, pointer coordinates, screenshots, cookies, authorization data, and unrestricted network destinations are not supported.

## Host integration

Provide a consent bridge that returns a complete, version-1 receipt with `state`, `policyVersion`, `grantedAt`, and `expiresAt`. When the consent provider supports subscriptions, pass its unsubscribe function through the client consent source so withdrawal can purge the queue and cancel retries immediately.

The public ingestion endpoint, rate limiting, bot filtering, durable forwarding, retention, and deletion are separate services and are not implemented by this plugin.
