# OpenGPT GitHub MCP Worker

Remote GitHub MCP server for ChatGPT Developer mode, deployed on Cloudflare Workers.

- MCP endpoint: remote `/mcp` server
- Runtime: Cloudflare Workers + Durable Objects
- Scope: GitHub repo read/write, workflow dispatch, PR flow, queue state, self-host operations
- Access model: Cloudflare Access in front of `/mcp`

Key docs:

- [Tool surface](/d:/VScode/opengpt-github-mcp-worker/docs/TOOL_SURFACE.md)
- [Release history](/d:/VScode/opengpt-github-mcp-worker/docs/releases/CHANGELOG.md)
- [ChatGPT project instructions](/d:/VScode/opengpt-github-mcp-worker/docs/chatgpt/CHATGPT_PROJECT_INSTRUCTIONS.md)
- [Short instructions](/d:/VScode/opengpt-github-mcp-worker/docs/chatgpt/CHATGPT_PROJECT_INSTRUCTIONS_SHORT.md)

## Root Layout

- `.github/`
- `docs/`
- `worker/`
- `README.md`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.mts`
- `wrangler.jsonc`

`.github/`, `package.json`, `wrangler.jsonc`, `tsconfig.json`, and `vitest.config.mts` stay at the root because GitHub Actions, npm, Wrangler, TypeScript, and Vitest resolve them from there.

## Quick Start

1. Install dependencies with `npm install`.
2. Put required secrets with `npx wrangler secret put GITHUB_APP_PRIVATE_KEY_PEM` and `npx wrangler secret put WEBHOOK_SECRET`.
3. Fill local `.dev.vars` from `.dev.vars.example` when developing locally.
4. Run `npm run check` for local validation.
5. Deploy with `npm run deploy` or rely on `push main -> cloudflare-ci -> cloudflare-self-deploy`.

## MCP Access Protection

Remote MCP access is expected to go through Cloudflare Access before requests reach the Worker.

- production `/mcp` should be protected by a Cloudflare Access application
- the Worker now expects Cloudflare Access identity headers when `MCP_REQUIRE_ACCESS_AUTH=true`
- local development can explicitly bypass Access by setting `MCP_REQUIRE_ACCESS_AUTH=false` in `.dev.vars`
- optional allowlists can be set with `MCP_ALLOWED_EMAILS` and `MCP_ALLOWED_EMAIL_DOMAINS`
- self deploy can inject `MCP_ALLOWED_EMAILS` and `MCP_ALLOWED_EMAIL_DOMAINS` from GitHub Actions secrets or repository variables at deploy time

Deploying the Worker alone is not sufficient for production MCP exposure. The Access policy is part of the production configuration.

## Cloudflare MCP Positioning

This repository is a remote GitHub MCP server deployed on Cloudflare Workers and exposed at `/mcp`.
It is different from Cloudflare's official `workers-mcp` project, which provides local CLI and proxy tooling for connecting an MCP client to methods on a Worker.

## What This Repo Does

- Exposes a remote `/mcp` endpoint for ChatGPT Developer mode.
- Wraps GitHub App authentication for GitHub REST API access.
- Stores worker/reviewer job state in a Durable Object.
- Receives GitHub webhooks at `/webhooks/github`.
- Supports direct GitHub read/write/action tools under phase 1 policy constraints.

## Current Tool Surface

The server exposes grouped tool families rather than one flat surface:

- overview and self-host guidance
- workspace registry and active repo context
- repository read and search
- repository write, PR, comment, and workflow dispatch
- branch cleanup and collaboration helpers
- queue, audit, and reviewer loop state

The generated full surface and permission presets live in [docs/TOOL_SURFACE.md](/d:/VScode/opengpt-github-mcp-worker/docs/TOOL_SURFACE.md).
Regenerate it with `npm run docs:tool-surface` after changing the catalog in [worker/src/tool-catalog.json](/d:/VScode/opengpt-github-mcp-worker/worker/src/tool-catalog.json).

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
npm run test:unit
npm run test:integration
npm run test:integration:runtime
npm run test:all
npm run ops:status
npm run docs:tool-surface
```

`test:integration` is a host-aware wrapper. On Windows it skips Durable Object runtime tests and prints the exact command to run on Linux/CI. `test:integration:runtime` always runs the full DO-backed suite.

Validation policy:

- Linux/CI is the source of truth for Durable Object runtime verification.
- Cloudflare live and mirror health checks are the source of truth for deployed behavior.
- Windows local runs are for fast unit checks and manual smoke work, not for authoritative DO runtime gating.
- `push main` runs `cloudflare-ci` first, and only a successful CI run triggers `cloudflare-self-deploy` to mirror.
- Manual `cloudflare-self-deploy` dispatch remains the path for explicit mirror or live promotion.
- Runtime integration coverage is split by surface:
  - `worker/test/runtime-http.spec.ts` covers HTTP routes, queue endpoints, and webhook handling.
  - `worker/test/runtime-mcp.spec.ts` covers MCP tools and queue actions exposed through `/mcp`.
  - `worker/test/queue-webhook.spec.ts` keeps focused webhook matching and reconciliation coverage.

## Required Secrets

Set these with `wrangler secret put` before deploy:

- `GITHUB_APP_PRIVATE_KEY_PEM`
- `WEBHOOK_SECRET`

Optional but recommended:

- `QUEUE_API_TOKEN`

Example:

```bash
npx wrangler secret put GITHUB_APP_PRIVATE_KEY_PEM
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put QUEUE_API_TOKEN
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
- `MCP_REQUIRE_ACCESS_AUTH`
- `MCP_ALLOWED_EMAILS`
- `MCP_ALLOWED_EMAIL_DOMAINS`
- `WORKING_STALE_AFTER_MS`
- `REVIEW_STALE_AFTER_MS`
- `DISPATCH_DEDUPE_WINDOW_MS`
- `AUDIT_RETENTION_COUNT`
- `DELIVERY_RETENTION_COUNT`
- `REQUIRE_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in real values.

Recommended production MCP setup:

1. Deploy the Worker.
2. Put Cloudflare Access in front of the Worker hostname or `/mcp` path.
3. Configure the identity provider and Access policy for the intended users.
4. Leave `MCP_REQUIRE_ACCESS_AUTH=true` in deployed environments.
5. Optionally set `MCP_ALLOWED_EMAILS` or `MCP_ALLOWED_EMAIL_DOMAINS` for in-worker allowlist enforcement.

Recommended deploy-time source of truth:

- set `MCP_ALLOWED_EMAILS` and `MCP_ALLOWED_EMAIL_DOMAINS` as GitHub Actions secrets when the values should stay private
- or use GitHub repository variables when the values are low sensitivity and easier operator visibility matters
- `cloudflare-self-deploy` prefers secrets, then repository variables, then falls back to the empty values in `wrangler.jsonc`

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
- `MCP_ALLOWED_EMAILS` optional, but recommended when only specific identities should reach `/mcp`
- `MCP_ALLOWED_EMAIL_DOMAINS` optional, but recommended when a whole Access-managed domain should reach `/mcp`

## Queue API Access

The maintenance queue endpoints under `/queue/*` are no longer public.

Use one of these headers when calling `/queue/job` or `/queue/jobs` directly:

- `X-Queue-Token: <QUEUE_API_TOKEN>`
- `Authorization: Bearer <QUEUE_API_TOKEN>`

`QUEUE_API_TOKEN` is preferred so queue maintenance auth is separated from GitHub webhook verification.
If `QUEUE_API_TOKEN` is unset, the worker falls back to `WEBHOOK_SECRET` for backward compatibility.
GitHub webhook deliveries still authenticate with `X-Hub-Signature-256`; they do not use `X-Queue-Token`.

## Batch Permission Bundles

Use `request_permission_bundle` when a web run needs one up-front approval covering multiple MCP actions.

- pick a preset such as `implementation_with_workflow`, `review_followup`, or `self_maintenance`
- add explicit capabilities when the preset is too broad or too narrow
- include expected follow-up work such as workflow reruns or branch cleanup in the same bundle request

The tool returns:

- grouped scope summary
- exact tool list covered by the bundle
- approval request text
- recommended follow-up guidance

For review work, use the `review_followup` preset. It includes the reviewer context path so GPT can gather the original request, PR diff, workflow results, and queue state before submitting a verdict.

The bundle definitions come from [worker/src/tool-catalog.json](/d:/VScode/opengpt-github-mcp-worker/worker/src/tool-catalog.json), which is also the source for the generated [docs/TOOL_SURFACE.md](/d:/VScode/opengpt-github-mcp-worker/docs/TOOL_SURFACE.md).

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

## ChatGPT Usage Guides

For request templates and project-instruction text, use:

- [CHATGPT_PROJECT_INSTRUCTIONS.md](/d:/VScode/opengpt-github-mcp-worker/docs/chatgpt/CHATGPT_PROJECT_INSTRUCTIONS.md)
- [CHATGPT_PROJECT_INSTRUCTIONS_SHORT.md](/d:/VScode/opengpt-github-mcp-worker/docs/chatgpt/CHATGPT_PROJECT_INSTRUCTIONS_SHORT.md)

For ad hoc prompting inside ChatGPT:

- call `help` first when the user is unsure how to phrase work; it now returns workflow choice, request checklist, and permission bundle guidance
- call `review_prepare_context` before `job_submit_review` when GPT is acting as reviewer
- submit review findings with `severity`, `file`, `summary`, and `rationale`; add `line_hint` and `required_fix` when the fix needs to be explicit
- prefer `job_progress` for concise status and `audit_list` only for full history
- use queue state and GitHub state as the source of truth, not an unregistered local folder

## Important Note

If a private key or webhook secret was pasted into chat or shared insecurely during setup, rotate both before production use.




