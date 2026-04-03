# Changelog

## Unreleased - 2026-04-03

Mission-control follow-up and documentation refresh.

- Added a dedicated run console guide that explains mission, lane, child job, YOLO guardrails, and the modular GUI layout.
- Reworked the top-level README and docs index so human operators and AI agents have separate fast-entry reading paths.
- Documented the mission-aware MCP and GUI surfaces as first-class operator entry points.
- Recorded the recent `HEAD /` and `HEAD /healthz` probe compatibility hardening so future operators do not rediscover the same issue from symptoms alone.

## 1.0.2 - 2026-03-24

Operational hardening and incident-memory update.

- Fixed self-host cross-worker health checks by enabling the Cloudflare `global_fetch_strictly_public` compatibility flag.
- Refreshed MCP discovery versioning to reduce stale client-side tool exposure metadata.
- Added `docs/incidents/` with an incident index, reusable template, and the March 24 MCP tool exposure incident report.
- Updated ChatGPT and operator documentation so future runtime errors are recorded in-repo and can be read or updated through existing MCP repo file tools.

## 1.0.1 - 2026-03-24

Operational follow-up release after mirror/live validation.

- Fixed self-host root routing so `GET /` redirects to `/gui/` instead of returning a JSON `404`.
- Fixed ChatGPT OAuth protected resource metadata to point `resource_documentation` at a reachable repository doc URL.
- Added runtime coverage for the root redirect and OAuth metadata documentation link.
- Re-synced local, GitHub `main`, mirror, and live to release commit `fc5f86f088410c271ac97b8f5af810005fdfbbad`.

## 1.0.0 - 2026-03-21

Initial stable release.

- Remote MCP surface split into focused tool groups with generated tool catalog documentation.
- Mirror-first Cloudflare deploy flow with separate CI validation and deploy workflows.
- Queue and review loop refactored into smaller modules with indexed lookup paths.
- Reviewer workflow upgraded with `review_prepare_context`, structured findings, and richer `help` output.
- Batch permission bundles added for web GPT approval flows.
- Windows local validation reduced to unit and smoke usage; Linux/CI is the authoritative runtime gate.
