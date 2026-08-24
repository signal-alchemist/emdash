# `sa-github-content-sync`

Sandboxed EmDash plugin for revision-safe synchronization of Git-authored articles and media.

## Responsibilities

- accept a signed, merge-only synchronization request;
- validate repository, branch, delivery ID, commit SHA, and source catalog;
- deduplicate deliveries and uploaded media;
- create/update content using an expected EmDash revision;
- record conflicts instead of overwriting manual production edits;
- provide delivery status and retry information in EmDash admin.

## Deliberate non-responsibilities

- generating article text or images;
- deciding whether a change is good enough to merge;
- storing analytics events;
- deploying LP code;
- deleting production content merely because a source file disappeared.

## Planned capabilities

- `content:write`
- `media:write`
- `network:request` limited to GitHub API/content hosts

The initial source is a compile-oriented skeleton. Webhook signature verification, schema validation, and EmDash content/media mutations are implementation tasks tracked in the Codex review issue.