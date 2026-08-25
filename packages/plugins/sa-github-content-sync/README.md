# `sa-github-content-sync`

Sandboxed EmDash plugin for revision-safe synchronization of Git-authored articles and media.

## Responsibilities

- accept a signed, merge-only synchronization request;
- validate repository, branch, delivery ID, commit SHA, and source catalog;
- deduplicate deliveries and uploaded media;
- create/update content using an expected EmDash revision;
- verify persisted content and media identity/hash after every apply;
- retain bounded durable apply receipts and revision-fenced human rollback receipts;
- record conflicts instead of overwriting manual production edits;
- provide delivery status and retry information in EmDash admin.

## Deliberate non-responsibilities

- generating article text or images;
- deciding whether a change is good enough to merge;
- storing analytics events;
- deploying LP code;
- deleting production content merely because a source file disappeared.

## Capabilities

- `content:write`
- `media:read` for persisted SHA-256 verification
- `media:write`
- `network:request` limited to GitHub API/content hosts

Rollback never deletes newly created content. It moves the verified post-state to a non-public state; updates restore receipt-backed prior fields only when the current revision still equals the verified post revision. A trusted reviewer and bounded rationale are required.
