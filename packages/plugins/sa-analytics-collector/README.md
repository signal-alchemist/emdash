# `sa-analytics-collector`

Native EmDash plugin for first-party browser instrumentation and event collection wiring.

Native format is required because visitor-facing script/page-fragment integration is not available to sandboxed plugins.

## Responsibilities

- inject a small, versioned analytics client;
- batch page, section, scroll, CTA, form, conversion, revenue, and experiment events;
- attach path, content ID, campaign, deployment SHA, and experiment variant;
- enforce payload size, rate, consent, and privacy rules;
- forward durable data to a dedicated Cloudflare analytics service.

## Boundary

The plugin storage collection is for development and operational buffering only. It is not the long-term raw analytics warehouse. Session replay, DOM snapshots, free-form form values, and unnecessary PII are explicitly out of scope.

The foundation includes a framework-neutral browser queue and a private development ingestion route. Public route security, page-fragment injection, and durable forwarding are follow-up implementation tasks.