# Desktop-First Fullstack MCP Roadmap

This document is the implementation source of truth for extending `opengpt-github-mcp-worker` into a desktop-first fullstack MCP control plane.

The original idea and API exploration live in [`../../opengpt_mcp_fullstack_api_spec.md`](../../opengpt_mcp_fullstack_api_spec.md). This roadmap is narrower: it fixes the order of implementation, the architectural constraints, the public interfaces to add, and the validation and rollback rules.

## Goals

- Make `ChatGPT Web + opengpt-github-mcp-worker` sufficient to build and validate desktop-first GUI applications end to end.
- Optimize for `Webview desktop shell` targets first, with Electron and Tauri as the initial runtime focus.
- Keep the current strengths of the worker:
  GitHub Actions for execution, Durable Objects for persistent state, and Cloudflare Workers for the MCP control plane.
- Close the loop from code change to verification, preview, browser evidence, desktop shell smoke, and release readiness.

## Non-goals

- A provider-neutral v1 implementation across multiple CI or cloud backends.
- Flutter-native or fully native desktop runtime support in v1.
- Replacing the existing `/gui/` static app with a new operational GUI product surface.
- Large breaking changes to existing `repo_*`, `workflow_*`, `job_*`, or self-host maintenance flows.

## Architecture Principles

- Stability first: preserve the current GitHub App, workflow allowlist, branch guardrails, and queue-driven state model.
- Preview/apply first: every multi-file or high-impact write path must support a preview step before a commit is created.
- Typed long-running state: queue state must move from ad-hoc `worker_manifest` payloads to a versioned manifest with dedicated sections for execution, verification, preview, browser, desktop, and runtime.
- Reuse before abstraction: v1 uses GitHub Actions and Cloudflare-native primitives directly, while leaving clear seams for future provider replacement.
- Evidence over narration: verification, browser, and desktop execution must return structured step results, artifacts, logs, and timestamps rather than only free-form summaries.

## Public Contracts

### Project capabilities contract

Target projects should provide `.opengpt/project-capabilities.json` with the fields below:

```json
{
  "runtime_kind": "webview_desktop_shell",
  "desktop_shell": "electron",
  "verify_profiles": ["desktop-smoke", "web-smoke"],
  "package_targets": ["win-x64"],
  "web_preview": {
    "enabled": true
  },
  "api_contract_sources": [],
  "db_mode": "none"
}
```

Initial defaults:

- `runtime_kind`: `webview_desktop_shell`
- `desktop_shell`: `electron` or `tauri`

### New MCP interfaces

- Repo change layer:
  `repo_get_diff`, `repo_batch_write`, `repo_apply_patchset`
- Verification layer:
  `verify_run`, `verify_list_suites`, `verify_get_logs`, `verify_compare_runs`
- Preview/browser layer:
  `preview_env_create`, `preview_env_get`, `preview_env_destroy`
  `browser_session_start`, `browser_action_batch`, `browser_collect_diagnostics`
- Desktop layer:
  `desktop_build_run`, `desktop_smoke_run`, `desktop_artifacts_get`
- API/DB/runtime layer:
  `api_contract_list`, `api_contract_get`, `api_request_run`, `api_contract_validate`
  `db_schema_inspect`, `db_migration_apply`, `db_seed_run`, `db_reset`, `db_query_safe`
  `runtime_log_query`, `runtime_error_cluster`, `incident_bundle_create`
- Release layer:
  `deploy_promote`, `deploy_rollback`, `deploy_health_matrix`, `release_verify`

## Phase Order

### Phase 0. Baseline and safety

- Keep `tool-catalog.json`, generated docs, and runtime MCP exposure in sync.
- Add CI enforcement so stale generated tool surface docs fail validation.
- Introduce typed queue manifest sections:
  `execution`, `verification`, `preview`, `browser`, `desktop`, `runtime`.
- Preserve backward compatibility for existing workflow dispatch and reconciliation behavior while migrating queue state readers and writers.

### Phase 1. Multi-file repo writes

- Add `repo_get_diff` for structured compare output with file-level hunks and rename metadata.
- Add `repo_batch_write` for preview/apply multi-file create, update, delete, rename, and scaffold operations.
- Add `repo_apply_patchset` for preview/apply unified diff patchsets across multiple files.
- Keep `repo_create_file`, `repo_upsert_file`, `repo_update_file`, and upload session tools unchanged.

### Phase 2. Standard execution and verification

- Introduce standard target-project workflows:
  `opengpt-exec.yml` for verify, preview, browser, and API/DB checks.
  `opengpt-package.yml` for desktop build, smoke, and packaging.
- Add `verify_run`, `verify_list_suites`, `verify_get_logs`, and `verify_compare_runs`.
- Link all long-running executions to `job_id` and persist step-level evidence into queue state.

### Phase 3. Preview and browser evidence

- Add preview lifecycle tools:
  `preview_env_create`, `preview_env_get`, `preview_env_destroy`.
- Preserve `gui_capture_run` and upgrade it so step evidence, screenshots, console logs, and failed network requests are retained.
- Add session-style browser tools for reliable web-layer validation before desktop shell packaging.

### Phase 4. Desktop shell execution

- Add `desktop_build_run`, `desktop_smoke_run`, and `desktop_artifacts_get`.
- Limit initial runtime support to Electron and Tauri.
- Separate browser-layer validation from desktop shell validation:
  browser tools validate rendered flows, desktop tools validate process, window, preload, IPC, and shell integration boundaries.

### Phase 5. API, DB, and runtime diagnosis

- Add contract inspection and validation for API surfaces.
- Add guarded DB schema, migration, seed, reset, and safe query tools.
- Add runtime log query, clustering, and incident bundle assembly to close the debugging loop across UI, backend, data, and logs.

### Phase 6. Release and rollback

- Add release gate and deployment control tools:
  `deploy_promote`, `deploy_rollback`, `deploy_health_matrix`, `release_verify`.
- Use both web preview evidence and desktop package evidence when deciding release readiness.

## Validation Criteria

- Generated tool docs must match `worker/src/tool-catalog.json`.
- Queue state readers and writers must preserve old behavior while adding typed manifest sections.
- Repo batch writes must support preview/apply and detect path collisions, stale refs, and blob mismatches.
- Patchset application must report patch conflicts deterministically.
- Existing runtime MCP tests for current tools must continue to pass.
- New repo write tests must cover:
  preview/apply behavior, rename handling, scaffold creation, unified patch application, and compare output.

## Rollback Rules

- If typed manifest migration causes regressions, fall back to legacy mirror fields while keeping the new sections populated.
- If batch write or patchset flows prove unstable, keep the tools behind preview usage only and continue relying on existing single-file writes.
- No destructive data-plane or deployment action should bypass explicit allowlists, stale-ref detection, or confirm-token style safety checks.
