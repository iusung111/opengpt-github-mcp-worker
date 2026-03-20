# Changelog

## 1.0.0 - 2026-03-21

Initial stable release.

- Remote MCP surface split into focused tool groups with generated tool catalog documentation.
- Mirror-first Cloudflare deploy flow with separate CI validation and deploy workflows.
- Queue and review loop refactored into smaller modules with indexed lookup paths.
- Reviewer workflow upgraded with `review_prepare_context`, structured findings, and richer `help` output.
- Batch permission bundles added for web GPT approval flows.
- Windows local validation reduced to unit and smoke usage; Linux/CI is the authoritative runtime gate.
