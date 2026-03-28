# Tool Surface

Generated from `worker/src/tool-catalog.json`.

## Groups

### Overview and self-host

Guidance, self-host inspection, live-only control-plane actions, and permission planning.

- `help`
- `request_permission_bundle`
- `repo_work_context`
- `self_host_status`
- `self_deploy`
- `self_bootstrap_repo_secrets`
- `self_sync_mirror_secrets`

### Workspace registry

Workspace discovery, registration, and active repo context management.

- `workspace_activate`
- `workspace_resolve`
- `workspace_register`
- `workspace_find_similar`
- `workspace_list`

### Repository read

Manifest-first repository navigation, summary/chunk file access, trees, search, issues, PRs, and workflow run read APIs.

- `repo_navigation_manifest`
- `repo_context_snapshot`
- `repo_doc_index_lookup`
- `repo_tool_index_lookup`
- `repo_get_file_summary`
- `repo_get_file_chunk`
- `repo_get_diff`
- `repo_read_budget_status`
- `repo_get_file`
- `repo_list_tree`
- `repo_tree_snapshot`
- `repo_search_code`
- `repo_search_issues`
- `issue_get`
- `pr_get`
- `pr_get_files`
- `workflow_allowlist_inspect`
- `workflow_runs_list`
- `workflow_run_get`
- `workflow_artifacts_list`

### Repository write

Branch creation, single-file and batch file edits including .github/workflows, PR creation and merge, comments, and workflow dispatch.

- `repo_create_branch`
- `repo_create_file`
- `repo_upsert_file`
- `repo_upload_start`
- `repo_upload_append`
- `repo_upload_commit`
- `repo_upload_abort`
- `repo_batch_write`
- `repo_apply_patchset`
- `repo_update_file`
- `pr_create`
- `pr_merge`
- `comment_create`
- `workflow_dispatch`
- `gui_capture_run`

### Collaboration and cleanup

Reviewer context preparation plus branch cleanup discovery and execution under repo guardrails.

- `review_prepare_context`
- `branch_cleanup_candidates`
- `branch_cleanup_execute`

### Verification

Standard capability-aware verification suites, run comparison, and workflow log access.

- `verify_list_suites`
- `verify_run`
- `verify_get_logs`
- `verify_compare_runs`

### Preview environments

Preview URL resolution, health probing, teardown, and queue-linked preview state.

- `preview_env_create`
- `preview_env_get`
- `preview_env_destroy`

### Browser automation

Session-based browser validation layered on the existing gui capture workflow and diagnostics artifacts.

- `browser_session_start`
- `browser_action_batch`
- `browser_collect_diagnostics`

### Desktop packaging

Desktop build, smoke, and packaging artifact retrieval for Electron/Tauri style projects.

- `desktop_build_run`
- `desktop_smoke_run`
- `desktop_artifacts_get`

### API and backend

API contract discovery, lightweight validation, and live request execution against previews or app URLs.

- `api_contract_list`
- `api_contract_get`
- `api_request_run`
- `api_contract_validate`

### Database

Schema inspection plus workflow-backed migration, seed, reset, and safe query operations.

- `db_schema_inspect`
- `db_migration_apply`
- `db_seed_run`
- `db_reset_prepare`
- `db_reset`
- `db_query_safe`

### Runtime observability

Workflow log querying, error clustering, and incident bundle assembly for debugging loops.

- `runtime_log_query`
- `runtime_error_cluster`
- `incident_bundle_create`

### Release and deploy

Promotion, rollback, release readiness, and deploy health evaluation.

- `deploy_promote`
- `deploy_rollback`
- `deploy_health_matrix`
- `release_verify`

### Queue and review loop

Persistent job tracking, audit history, reviewer actions, and queue-driven state transitions.

- `job_create`
- `job_get`
- `job_progress`
- `jobs_list`
- `job_event_feed`
- `audit_list`
- `job_update_status`
- `job_append_note`
- `job_submit_review`
- `jobs_list_pending_review`
- `jobs_list_pending_rework`

## Permission Presets

### Repo review and investigation

- preset id: `repo_readonly_review`
- description: Inspect repository state, open PRs, workflow runs, and queue state without mutating code.
- capabilities: `read`, `workspace`, `queue`
- group ids: `overview`, `workspace`, `repo_read`, `queue`

### Implementation with PR

- preset id: `implementation_with_pr`
- description: Read repo state, create branches, edit files, open PRs, and track queue progress.
- capabilities: `read`, `write`, `workspace`, `queue`
- group ids: `overview`, `workspace`, `repo_read`, `repo_write`, `queue`

### Implementation with workflow dispatch

- preset id: `implementation_with_workflow`
- description: Implementation, workflow-file edits, allowlisted workflow dispatch, and queue tracking.
- capabilities: `read`, `write`, `workflow`, `workspace`, `queue`
- group ids: `overview`, `workspace`, `repo_read`, `repo_write`, `verification`, `preview`, `browser`, `desktop`, `api_backend`, `database`, `observability`, `release`, `queue`

### Desktop fullstack control plane

- preset id: `desktop_fullstack`
- description: End-to-end GUI implementation with verification, preview, browser, desktop, backend, database, observability, and release controls.
- capabilities: `read`, `write`, `workflow`, `workspace`, `queue`
- group ids: `overview`, `workspace`, `repo_read`, `repo_write`, `verification`, `preview`, `browser`, `desktop`, `api_backend`, `database`, `observability`, `release`, `queue`

### Review follow-up

- preset id: `review_followup`
- description: Respond to review findings, update PR state, and track reviewer/worker handoff.
- capabilities: `read`, `write`, `review`, `queue`
- group ids: `overview`, `repo_read`, `repo_write`, `collaboration`, `queue`

### Maintainer cleanup

- preset id: `maintainer_cleanup`
- description: Inspect open PRs, active jobs, and remove safe stale agent branches.
- capabilities: `read`, `write`, `workspace`, `queue`
- group ids: `overview`, `workspace`, `repo_read`, `collaboration`, `queue`

### Self maintenance and deploy

- preset id: `self_maintenance`
- description: Inspect self-host state from any environment, but allow secret sync and live promotion only from the live self-host worker.
- capabilities: `read`, `workflow`, `self_host`
- group ids: `overview`, `workspace`, `repo_read`, `repo_write`, `queue`

