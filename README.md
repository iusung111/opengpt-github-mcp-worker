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

- `help`
- `self_host_status`
- `self_deploy`
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
- `pr_merge`
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
npm run ops:status
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
- `SELF_REPO_KEY`
- `SELF_DEPLOY_WORKFLOW`
- `SELF_LIVE_URL`
- `SELF_MIRROR_URL`
- `SELF_CURRENT_URL`
- `SELF_DEFAULT_DEPLOY_TARGET`
- `SELF_REQUIRE_MIRROR_FOR_LIVE`
- `WORKING_STALE_AFTER_MS`
- `REVIEW_STALE_AFTER_MS`
- `DISPATCH_DEDUPE_WINDOW_MS`
- `AUDIT_RETENTION_COUNT`
- `DELIVERY_RETENTION_COUNT`
- `REQUIRE_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in real values.

Self-host tracking defaults:

- `SELF_LIVE_URL`: public Cloudflare live endpoint used for maintenance health checks
- `SELF_MIRROR_URL`: secondary mirror endpoint; it can temporarily point at the same Worker until a separate mirror exists
- `SELF_CURRENT_URL`: the URL of the environment currently running this config, used to avoid misleading self-health fetches
- `SELF_REPO_KEY`: GitHub self-repo used by `self_host_status`
- `SELF_DEPLOY_WORKFLOW`: GitHub Actions workflow that deploys this Worker
- `SELF_DEFAULT_DEPLOY_TARGET`: default target for self deploy requests; set to `mirror` for safer self-improvement
- `SELF_REQUIRE_MIRROR_FOR_LIVE`: when `true`, live promotion is blocked until a distinct healthy mirror exists

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

For maintenance and self-improvement checks, `self_host_status` reads the configured live/mirror URLs, pings `/healthz`, and also inspects the self GitHub repo plus recent self-deploy workflow runs.
Use `self_deploy` to dispatch mirror-first self deploys from MCP instead of sending the self repo directly to live.

For GitHub Actions based self deploys, also add these repository secrets so the workflow can sync Worker secrets to `live` and `mirror`:

- `APP_PRIVATE_KEY_PEM`
- `WEBHOOK_SECRET`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Queue API Access

The maintenance queue endpoints under `/queue/*` are no longer public.

Use one of these headers when calling `/queue/job` or `/queue/jobs` directly:

- `X-Queue-Token: <WEBHOOK_SECRET>`
- `Authorization: Bearer <WEBHOOK_SECRET>`

This reuses the existing `WEBHOOK_SECRET` so webhook validation and queue maintenance stay aligned.
GitHub webhook deliveries still authenticate with `X-Hub-Signature-256`; they do not use `X-Queue-Token`.

## Mirror-First Self Improvement

Recommended flow for changes to this repo:

1. Merge or push the self-repo change.
2. Let `main` deploy automatically to the `mirror` Worker.
3. Verify the mirror with `self_host_status` or `npm run ops:status`.
4. Promote to live with `self_deploy` using `deploy_target=live`.

The GitHub workflow now defaults to:

- `push main` -> deploy `mirror`
- manual `workflow_dispatch` -> choose `mirror` or `live`
- `live` promotion can require a healthy mirror first

## GitHub App / Repo Setup

Target repo assumptions for phase 1:

- allowlisted repo only
- direct writes only on `agent/*`
- no force-push
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
- Workflows: Read and write
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
- approved pull requests can be merged directly through the `pr_merge` MCP tool when the repo and PR state allow it

## Change Request Templates

Use these directly in ChatGPT after selecting the MCP connector.

If the user first asks what kinds of work are supported or how to phrase a request, call `help` before starting implementation.
The `help` response is structured around workflows, recommended request fields, examples, and next actions so web GPT can guide the user without a long free-form explanation.

Small real change with PR:

```text
iusung111/OpenGPT?먯꽌 ?ㅼ쓬 蹂寃?吏꾪뻾:
- job_id: change-001
- 紐⑺몴: README.md 留덉?留됱뿉 "Managed by OpenGPT GitHub MCP worker." ??以?異붽?
- 蹂寃??뚯씪: README.md
- dry_run: false
- ?꾨즺 湲곗?: branch push? PR ?앹꽦源뚯?
```

Single file code edit:

```text
iusung111/OpenGPT?먯꽌 ?ㅼ쓬 蹂寃?吏꾪뻾:
- job_id: fix-001
- 紐⑺몴: <援ъ껜?곸씤 ?섏젙 ?댁슜>
- 蹂寃??뚯씪: <?? app/main.py>
- dry_run: false
- ?꾨즺 湲곗?: 媛?ν븳 踰붿쐞??寃利???PR ?앹꽦
```

Real change intended for `main`:

```text
iusung111/OpenGPT?먯꽌 ?ㅼ쓬 蹂寃쎌쓣 吏꾪뻾?섍퀬 main 諛섏쁺 湲곗??쇰줈 留덈Т由ы빐以?
- job_id: main-ready-001
- 紐⑺몴: <援ъ껜?곸씤 ?섏젙 ?댁슜>
- 蹂寃??뚯씪: <path??
- dry_run: false
- ?꾨즺 湲곗?: 寃利??꾨즺, branch push, PR ?앹꽦, 洹몃━怨?main 諛섏쁺???꾩슂??留덉?留??≪뀡 ?뺣━源뚯?
```

Dry-run only:

```text
iusung111/OpenGPT?먯꽌 ?ㅼ쓬 ?묒뾽??dry-run?쇰줈 寃利앺빐以?
- job_id: dryrun-001
- 紐⑺몴: <臾댁뾿??諛붽?吏>
- 蹂寃??뚯씪: <path??
- dry_run: true
- ?꾨즺 湲곗?: workflow success? queue ?곹깭 ?꾩씠 ?뺤씤
```

Reviewer follow-up:

```text
iusung111/OpenGPT?먯꽌 job_id <媛????꾩옱 ?곹깭瑜??뺤씤?섍퀬,
PR / workflow / queue 湲곗??쇰줈 ?ㅼ쓬 ?≪뀡???뺣━?댁쨾.
```

Recommended request shape:

- `job_id`: unique value like `change-001`, `fix-002`, `docs-003`
- `紐⑺몴`: exact user-facing or code-facing change
- `蹂寃??뚯씪`: one or more expected target paths
- `dry_run`: `true` for validation only, `false` for branch and PR creation
- `?꾨즺 湲곗?`: what counts as done

If the user says `main??諛섏쁺`, interpret that as:

- this is a real change request, not a dry run
- complete validation and create or update the PR needed for merge
- if merge tooling is available and the PR is ready, attempt the merge
- if direct merge is unavailable, report the exact remaining merge step instead of pretending `main` was updated directly

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
- keep a single active repo context so workspace recency stays unified around the repo currently being worked on

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
