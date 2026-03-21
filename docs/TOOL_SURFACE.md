# Tool Surface

Generated from `worker/src/tool-catalog.json`.

## Groups

### Overview and self-host

Guidance, self-host inspection, deploy controls, and permission planning.

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

Repository files, trees, search, issues, PRs, and workflow read APIs.

- `repo_get_file`
- `repo_list_tree`
- `repo_tree_snapshot`
- `repo_search_code`
- `repo_search_issues`
- `issue_get`
- `pr_get`
- `pr_get_files`
- `workflow_runs_list`
- `workflow_run_get`
- `workflow_artifacts_list`

### Repository write

Branch creation, file edits, PR creation and merge, comments, and workflow dispatch.

- `repo_create_branch`
- `repo_update_file`
- `pr_create`
- `pr_merge`
- `comment_create`
- `workflow_dispatch`

### Collaboration and cleanup

Reviewer context preparation plus branch cleanup discovery and execution under repo guardrails.

- `review_prepare_context`
- `branch_cleanup_candidates`
- `branch_cleanup_execute`

### Queue and review loop

Persistent job tracking, audit history, reviewer actions, and queue-driven state transitions.

- `job_create`
- `job_get`
- `job_progress`
- `jobs_list`
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
- description: Implementation plus allowlisted workflow dispatch and queue tracking.
- capabilities: `read`, `write`, `workflow`, `workspace`, `queue`
- group ids: `overview`, `workspace`, `repo_read`, `repo_write`, `queue`

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
- description: Inspect self-host state, sync secrets, and promote mirror/live environments.
- capabilities: `read`, `workflow`, `self_host`
- group ids: `overview`, `workspace`, `repo_read`, `repo_write`, `queue`

