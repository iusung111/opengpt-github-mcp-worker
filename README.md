# OpenGPT GitHub MCP Worker

Cloudflare Workers + Durable Objects based GitHub MCP server for web ChatGPT Developer mode.

## What This Repo Does

- Exposes a remote `/mcp` endpoint for ChatGPT Developer mode.
- Wraps GitHub App authentication for GitHub REST API access.
- Stores worker/reviewer job state in a Durable Object.
- Receives GitHub webhooks at `/webhooks/github`.
- Supports direct GitHub read/write/action tools under phase 1 policy constraints.

## Current Tool Surface

Read tools:

- `repo_work_context`
- `branch_cleanup_candidates`
- `workspace_resolve`
- `workspace_find_similar`
- `workspace_list`
- `repo_get_file`
- `repo_list_tree`
- `issue_get`
- `pr_get`
- `pr_get_files`
- `workflow_runs_list`
- `workflow_run_get`
- `workflow_artifacts_list`
- `job_get`
- `job_progress`
- `jobs_list`
- `audit_list`
- `jobs_list_pending_review`
- `jobs_list_pending_rework`

Write/action tools:

- `branch_cleanup_execute`
- `workspace_register`
- `repo_create_branch`
- `repo_update_file`
- `pr_create`
- `comment_create`
- `workflow_dispatch`
- `job_create`
- `job_update_status`
- `job_append_note`
- `job_submit_review`

## Local Validation

```bash
npm install
npm run check
```

Useful commands:

```bash
npm run dev
npm run cf-typegen
npm run typecheck
npm test -- --run
```

## Required Secrets

Set these with `wrangler secret put` before deploy:

- `GITHUB_APP_PRIVATE_KEY_PEM`
- `WEBHOOK_SECRET`

Example:

```bash
npx wrangler secret put GITHUB_APP_PRIVATE_KEY_PEM
npx wrangler secret put WEBHOOK_SECRET
```

## Non-Secret Config

These come from `wrangler.jsonc` vars and can be adjusted there:

- `GITHUB_ALLOWED_REPOS`
- `GITHUB_ALLOWED_WORKFLOWS`
- `AGENT_BRANCH_PREFIX`
- `DEFAULT_BASE_BRANCH`
- `DEFAULT_AUTO_IMPROVE_MAX_CYCLES`
- `WORKING_STALE_AFTER_MS`
- `REVIEW_STALE_AFTER_MS`
- `DISPATCH_DEDUPE_WINDOW_MS`
- `AUDIT_RETENTION_COUNT`
- `DELIVERY_RETENTION_COUNT`
- `REQUIRE_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in real values.

Queue stability defaults:

- `WORKING_STALE_AFTER_MS`: when a `working` job without a linked workflow run is treated as stale and sent back to worker rework or auto-redispatch
- `REVIEW_STALE_AFTER_MS`: when a `review_pending` job is annotated as stale for reviewer attention
- `DISPATCH_DEDUPE_WINDOW_MS`: short idempotency window that suppresses repeated identical workflow dispatch requests for the same job cycle
- `AUDIT_RETENTION_COUNT`: maximum number of recent audit records to keep in Durable Object storage
- `DELIVERY_RETENTION_COUNT`: maximum number of recent GitHub delivery ids kept for webhook dedupe

## Deploy Flow

1. Authenticate to Cloudflare.
2. Put the two required secrets.
3. Update `wrangler.jsonc` vars if repo or workflow policy changed.
4. Deploy.

```bash
npx wrangler login
npx wrangler secret put GITHUB_APP_PRIVATE_KEY_PEM
npx wrangler secret put WEBHOOK_SECRET
npm run deploy
```

After deploy, note the Worker URL and use:

- MCP endpoint: `https://<worker-url>/mcp`
- webhook endpoint: `https://<worker-url>/webhooks/github`
- health check: `https://<worker-url>/healthz`

## GitHub App / Repo Setup

Target repo assumptions for phase 1:

- allowlisted repo only
- direct writes only on `agent/*`
- no merge/force-push
- GitHub Actions workflows allowlisted to `agent-run.yml` and `pr-validate.yml`

Branch cleanup guardrails:

- cleanup applies only to `agent/*`
- default branch deletion is forbidden
- a branch with an open PR cannot be deleted
- a branch linked to an active queue job cannot be deleted
- prefer `branch_cleanup_candidates` before `branch_cleanup_execute`
- branch deletion is a direct cleanup action, not a workflow-dispatch or workflow-file-edit task

GitHub App minimum permissions:

- Contents: Read and write
- Pull requests: Read and write
- Issues: Read and write
- Actions: Read and write
- Metadata: Read only

Recommended webhook events:

- `workflow_run`
- `pull_request`

## Live Smoke Checks

After deploy:

1. `GET /healthz`
2. `GET /github/app-installation`
3. Call MCP `listTools`
4. Call MCP `job_create`
5. Dispatch `agent-run.yml`
6. Confirm webhook-driven state transitions with `job_get`

Operational safety additions:

- repeated GitHub webhook deliveries are deduplicated via `X-GitHub-Delivery`
- repeated identical `workflow_dispatch` requests for the same active job cycle are suppressed
- stale `working` jobs are reconciled automatically on queue reads
- stale `review_pending` jobs keep reviewer ownership but expose `stale_reason`
- repeated reads do not re-append the same stale-review note or re-audit an unchanged stale reason
- audit history can be inspected through the read-only `audit_list` MCP tool
- concise in-flight progress can be inspected through the read-only `job_progress` MCP tool
- old audit and webhook delivery dedupe records are pruned automatically by configured retention counts
- workspace registration rejects non-absolute or traversal-style paths
- queue-side validation failures are returned as structured JSON errors instead of uncaught Durable Object exceptions
- selected write tools now return more specific failure codes such as `workflow_not_allowlisted` and `branch_has_active_job`

## Change Request Templates

Use these directly in ChatGPT after selecting the MCP connector.

Small real change with PR:

```text
iusung111/OpenGPT에서 다음 변경 진행:
- job_id: change-001
- 목표: README.md 마지막에 "Managed by OpenGPT GitHub MCP worker." 한 줄 추가
- 변경 파일: README.md
- dry_run: false
- 완료 기준: branch push와 PR 생성까지
```

Single file code edit:

```text
iusung111/OpenGPT에서 다음 변경 진행:
- job_id: fix-001
- 목표: <구체적인 수정 내용>
- 변경 파일: <예: app/main.py>
- dry_run: false
- 완료 기준: 가능한 범위의 검증 후 PR 생성
```

Dry-run only:

```text
iusung111/OpenGPT에서 다음 작업을 dry-run으로 검증해줘:
- job_id: dryrun-001
- 목표: <무엇을 바꿀지>
- 변경 파일: <path들>
- dry_run: true
- 완료 기준: workflow success와 queue 상태 전이 확인
```

Reviewer follow-up:

```text
iusung111/OpenGPT에서 job_id <값>의 현재 상태를 확인하고,
PR / workflow / queue 기준으로 다음 액션을 정리해줘.
```

Recommended request shape:

- `job_id`: unique value like `change-001`, `fix-002`, `docs-003`
- `목표`: exact user-facing or code-facing change
- `변경 파일`: one or more expected target paths
- `dry_run`: `true` for validation only, `false` for branch and PR creation
- `완료 기준`: what counts as done

## Chat UX Guidance

If you want web ChatGPT to behave more like Codex without requiring rigid user prompts every time, use the project instruction guide in [CHATGPT_PROJECT_INSTRUCTIONS.md](/home/uieseong/workspace/opengpt-github-mcp-worker/CHATGPT_PROJECT_INSTRUCTIONS.md).

For a shorter version that is easier to paste into ChatGPT Project instructions, use [CHATGPT_PROJECT_INSTRUCTIONS_SHORT.md](/home/uieseong/workspace/opengpt-github-mcp-worker/CHATGPT_PROJECT_INSTRUCTIONS_SHORT.md).

It includes:

- natural-language-first development flow
- automatic job id and execution-path selection
- dedicated GitHub workspace folder defaults
- similar-folder detection before creating a new repo workspace
- a short confirmation rule only when reuse is ambiguous

The MCP server now also exposes workspace-registry tools so web ChatGPT can:

- use the GitHub repo itself as the default working context
- inspect open PRs, active jobs, and recent workflow runs before starting new work
- look up the default GitHub workspace folder for a repo
- find similar registered workspace folders before creating a new one
- register a confirmed workspace path for future reuse

For longer read or investigation phases, web ChatGPT can make progress visible by:

- appending short milestones with `job_append_note`
- reading the latest milestone and recent audit trail with `job_progress`
- using `audit_list` only when the full recent timeline is needed

For write-heavy web runs, web ChatGPT should also avoid late approval stalls by:

- requesting the smallest useful permission bundle near the start of the run
- including expected follow-up steps such as workflow reruns, PR updates, or branch cleanup in that initial approval request
- marking approval waits as explicit blocked milestones with `job_append_note`
- surfacing the blocked state with `job_progress` instead of appearing idle

For completion messages in web ChatGPT:

- show a short summary first by default
- keep the default close-out focused on outcome, validation, and blockers
- hold back detailed file lists, logs, and audit history unless the user asks for more detail

Important limit:

- the preferred source of truth is now the GitHub repo and MCP queue state, not a local folder
- the remote MCP server still cannot inspect your local filesystem directly
- similar-folder checks work against the registered workspace registry, not your raw disk state

## Important Note

If a private key or webhook secret was pasted into chat or shared insecurely during setup, rotate both before production use.
