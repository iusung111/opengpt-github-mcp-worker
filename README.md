# OpenGPT GitHub MCP Worker

Remote GitHub MCP server for ChatGPT Developer mode, deployed on Cloudflare Workers.

This repository now has two operator surfaces:

- MCP endpoints for ChatGPT and direct clients
- a mission-aware run console that groups child jobs under one control plane

## Start Here

If you are a human operator:

1. Read [docs/README.md](./docs/README.md).
2. Read [docs/MCP_ACCESS.md](./docs/MCP_ACCESS.md) for `/mcp` auth and deploy shape.
3. Read [docs/CHATGPT_MCP.md](./docs/CHATGPT_MCP.md) for `/chatgpt/mcp` OAuth or OIDC setup.
4. Read [docs/RUN_CONSOLE.md](./docs/RUN_CONSOLE.md) before working in `/gui/`.

If you are an AI agent:

1. Read this file for repo shape and validation entry points.
2. Read [docs/README.md](./docs/README.md) for the document map.
3. Read [docs/TOOL_SURFACE.md](./docs/TOOL_SURFACE.md) for the generated MCP catalog.
4. Read [docs/RUN_CONSOLE.md](./docs/RUN_CONSOLE.md) when the task touches queue orchestration, mission control, or the GUI console.

## What This Worker Does

- serves `/mcp` behind Cloudflare Access
- serves `/chatgpt/mcp` behind OAuth or OIDC-aware bearer auth
- receives GitHub webhooks and executes queue-driven job orchestration
- exposes `/gui/` as the operator run console
- groups multiagent work as `mission -> lanes -> child jobs`

## Core Concepts

- `job`: the execution unit tracked by the queue and review loop
- `mission`: an aggregate record that owns a set of dependent lanes
- `lane`: one branch of work inside a mission DAG, backed by a child `job_id`
- `YOLO mode`: mission-scoped auto-approval for safe approvals only; deploy, release, reset, and promotion actions stay blocked

The mission layer is additive. Existing `job_*` flows still work for standalone runs.

## Repository Layout

- `.github/` GitHub Actions and automation
- `docs/` operator, deploy, incident, and integration documentation
- `public/` GUI assets, including the modular run console
- `worker/` Cloudflare Worker runtime, queue domain, MCP tools, and tests
- `wrangler.jsonc` runtime bindings and deploy config

## Runtime Surfaces

- GUI root: `GET` and `HEAD` `/` redirect to `/gui/`
- Static GUI: `/gui/`
- Direct MCP: `/mcp`
- ChatGPT MCP: `/chatgpt/mcp`
- GitHub webhook: `/webhooks/github`
- Health: `GET` and `HEAD` `/healthz`
- Private queue API: `/queue/*`

Queue routes require either:

- `X-Queue-Token: <QUEUE_API_TOKEN>`
- `Authorization: Bearer <QUEUE_API_TOKEN>`

If `QUEUE_API_TOKEN` is unset, the worker falls back to `WEBHOOK_SECRET` for backward compatibility.

## Production Model

- `push main` runs `cloudflare-ci`
- successful CI auto-deploys `mirror`
- `live` is promoted manually through `cloudflare-self-deploy`
- Cloudflare Access remains the gate for `/mcp`
- OAuth or OIDC bearer auth remains the gate for `/chatgpt/mcp`

Deploying the Worker alone is not the full production setup. Production also depends on Cloudflare Access and OAuth or OIDC policy being configured correctly.

## Local Setup

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars`
3. Add required Worker secrets:
   - `npx wrangler secret put GITHUB_APP_PRIVATE_KEY_PEM`
   - `npx wrangler secret put WEBHOOK_SECRET`
4. Run `npm run check`
5. Start local development with `npm run dev`

## Validation

Preferred:

```bash
npm run check
```

Focused:

```bash
npm run typecheck
npm run test:unit
npm run test:integration:runtime
npm run ops:status
npm run docs:tool-surface:check
```

Repo-specific validation guidance lives in [AGENTS.md](./AGENTS.md).

## Required Secrets

Worker secrets:

- `GITHUB_APP_PRIVATE_KEY_PEM`
- `WEBHOOK_SECRET`

Optional Worker secret:

- `QUEUE_API_TOKEN`

GitHub Actions secrets for self-deploy:

- `APP_PRIVATE_KEY_PEM`
- `WEBHOOK_SECRET`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `MCP_ALLOWED_EMAILS` optional
- `MCP_ALLOWED_EMAIL_DOMAINS` optional
- `CHATGPT_MCP_AUTH_MODE` optional
- `CHATGPT_MCP_ISSUER` optional
- `CHATGPT_MCP_AUDIENCE` optional
- `CHATGPT_MCP_JWKS_URL` optional
- `CHATGPT_MCP_JWKS_JSON` optional
- `CHATGPT_MCP_ALLOWED_EMAILS` optional

`cloudflare-self-deploy` resolves MCP and ChatGPT MCP auth values from GitHub Actions secrets first, then repository variables, then `wrangler.jsonc`.

## Key Config

Primary runtime config lives in [wrangler.jsonc](./wrangler.jsonc).

Important vars:

- `GITHUB_ALLOWED_REPOS`
- `GITHUB_ALLOWED_WORKFLOWS`
- `GITHUB_ALLOWED_WORKFLOWS_BY_REPO`
- `MCP_REQUIRE_ACCESS_AUTH`
- `MCP_ALLOWED_EMAILS`
- `MCP_ALLOWED_EMAIL_DOMAINS`
- `CHATGPT_MCP_AUTH_MODE`
- `CHATGPT_MCP_ISSUER`
- `CHATGPT_MCP_AUDIENCE`
- `CHATGPT_MCP_JWKS_URL`
- `CHATGPT_MCP_ALLOWED_EMAILS`
- `SELF_LIVE_URL`
- `SELF_MIRROR_URL`
- `SELF_CURRENT_URL`
- `SELF_DEFAULT_DEPLOY_TARGET`
- `SELF_REQUIRE_MIRROR_FOR_LIVE`

Workflow allowlist config lives in [worker/config/workflow-allowlist.json](./worker/config/workflow-allowlist.json).

Tool catalog source lives in [worker/src/tool-catalog.json](./worker/src/tool-catalog.json).

Target repos can opt into the desktop-first fullstack tool surface with `.opengpt/project-capabilities.json` plus the standard GitHub workflows `opengpt-exec.yml` and `opengpt-package.yml`.

## Documentation Map

- [docs/README.md](./docs/README.md)
- [docs/RUN_CONSOLE.md](./docs/RUN_CONSOLE.md)
- [docs/MCP_ACCESS.md](./docs/MCP_ACCESS.md)
- [docs/CHATGPT_MCP.md](./docs/CHATGPT_MCP.md)
- [docs/TOOL_SURFACE.md](./docs/TOOL_SURFACE.md)
- [docs/project-capabilities.example.json](./docs/project-capabilities.example.json)
- [docs/desktop-fullstack-mcp-roadmap.md](./docs/desktop-fullstack-mcp-roadmap.md)
- [docs/incidents/README.md](./docs/incidents/README.md)
- [docs/releases/CHANGELOG.md](./docs/releases/CHANGELOG.md)

## GitHub App Assumptions

- allowlisted repos only
- direct writes only on `agent/*`
- no force-push
- workflow dispatch limited to the allowlisted workflow set
- repo-specific workflow allowlists override the global fallback

Minimum GitHub App permissions:

- Contents: Read and write
- Pull requests: Read and write
- Issues: Read and write
- Actions: Read and write
- Workflows: Read and write
- Metadata: Read only
