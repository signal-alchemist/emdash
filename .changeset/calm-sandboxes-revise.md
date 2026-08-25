---
"emdash": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes sandboxed content mutations on Cloudflare and workerd so `content.update` preserves `expectedRevision` and `slug`, while `content.publish` and `content.unpublish` return revision-aware content items. Stale revision tokens fail with a conflict before content changes.
