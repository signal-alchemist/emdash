# `sa-content-insights`

Sandboxed EmDash plugin for editorial metric snapshots, experiment records, and evidence-backed improvement proposals.

## Responsibilities

- ingest normalized snapshots from the external analytics pipeline;
- attach snapshots and experiment history to a stable content ID/path;
- show query, CTR, section exposure, scroll, CTA, form, conversion, and revenue signals;
- expose machine-readable evidence to an improvement agent;
- retain proposal and decision traceability.

## Boundary

This plugin is an editorial view, not the raw analytics warehouse. Browser events, ad exports, Search Console rows, and CRM records remain in a dedicated store and are aggregated before ingestion.

The plugin never merges a pull request or publishes a production change automatically.