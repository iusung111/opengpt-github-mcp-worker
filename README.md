# OpenGPT GitHub MCP Worker

Remote GitHub MCP server for ChatGPT Developer mode, deployed on Cloudflare Workers.

- Direct MCP endpoint: `/mcp`
- ChatGPT connector endpoint: `/chatgpt/mcp`
- Runtime: Cloudflare Workers + Durable Objects
- Scope: GitHub repo read/write including workflow files, workflow dispatch, PR flow, queue state, self-host operations
- Access model: Cloudflare Access for direct `/mcp`, OIDC bearer auth for `/chatgpt/mcp`

## Docs

- [MCP access and deployment](/d:/VScode/opengpt-github-mcp-worker/docs/MCP_ACCESS.md)
- [ChatGPT connector auth](/d:/VScode/opengpt-github-mcp-worker/docs/CHATGPT_MCP.md)
- [ChatGPT connector incident report 2026-03-22](/d:/VScode/opengpt-github-mcp-worker/docs/chatgpt/CHATGPT_CONNECTOR_INCIDENT_2026-03-22.md)
- [Tool surface](/d:/VScode/opengpt-github-mcp-worker/docs/TOOL_SURFACE.md)
- [Release history](/d:/VScode/opengpt-github-mcp-worker/docs/releases/CHANGELOG.md)
- [ChatGPT project instructions](/d:/VScode/opengpt-github-mcp-worker/docs/chatgpt/CHATGPT_PROJECT_INSTRUCTIONS.md)
- [Short instructions](/d:/VScode/opengpt-github-mcp-worker/docs/chatgpt/CHATGPT_PROJECT_INSTRUCTIONS_SHORT.md)

## Repository Layout

- `.github/`
- `docs/`
- `worker/`
- `README.md`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.mts`
- `wrangler.jsonc`

The root keeps only runtime entrypoints and top-level config that GitHub Actions, npm, Wrangler, TypeScript, and Vitest resolve directly.

## Current Production Model

- `push main` runs `cloudflare-ci`
- successful CI auto-deploys `mirror`
- `live` is promoted manually through `cloudflare-self-deploy`
- `/mcp` is expected to sit behind Cloudflare Access
- `/chatgpt/mcp` is expected to sit behind OAuth/OIDC-aware ChatGPT custom connector auth
- deployed Workers require `MCP_REQUIRE_ACCESS_AUTH=true`
- deployed Workers also enforce `MCP_ALLOWED_EMAILS` and/or `MCP_ALLOWED_EMAIL_DOMAINS` when configured
- deployed Workers can separately enforce `CHATGPT_MCP_ALLOWED_EMAILS` on `/chatgpt/mcp`

Deploying the Worker alone is not sufficient for production MCP exposure. Cloudflare Access policy protects `/mcp`, and an external OAuth/OIDC provider protects `/chatgpt/mcp`.

## Quick Start

1. `npm install`
2. Add Worker secrets:
   - `npx wrangler secret put GITHUB_APP_PRIVATE_KEY_PEM`
   - `npx wrangler secret put WEBHOOK_SECRET`
3. Copy `.dev.vars.example` to `.dev.vars` for local work.
4. Run `npm run check`.
5. Use `npm run dev` for local development.

## Validation

Preferred local validation:

```bash
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

Notes:

- `cf-typegen`, `test:integration`, and `test:integration:runtime` pin `workerd` temporary paths to repo-local `.wrangler/state/local-workerd/` so runtime tooling does not depend on the host temp directory.
- On Windows, runtime tests use ephemeral Durable Object storage instead of SQLite-backed local persistence to avoid `workerd` path-related `SQLITE_CANTOPEN` failures.
- Linux/CI remains the source of truth for Durable Object runtime verification.
- live and mirror `/healthz` checks are the source of truth for deployed behavior.

## Required Secrets

Worker secrets:

- `GITHUB_APP_PRIVATE_KEY_PEM`
- `WEBHOOK_SECRET`

Optional worker secret:

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

`cloudflare-self-deploy` prefers the MCP and ChatGPT MCP auth vars from GitHub Actions secrets, then repository variables, then the defaults in `wrangler.jsonc`.

## Non-Secret Config

Primary config lives in [`wrangler.jsonc`](/d:/VScode/opengpt-github-mcp-worker/wrangler.jsonc).

Most important vars:

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

For local development, copy `.dev.vars.example` to `.dev.vars` and fill real values there.

## Runtime Endpoints

- Direct MCP: `https://<worker-url>/mcp`
- ChatGPT MCP: `https://<worker-url>/chatgpt/mcp`
- Webhook: `https://<worker-url>/webhooks/github`
- Health: `https://<worker-url>/healthz`
- Queue API: `/queue/*`

Queue routes are not public. Use one of:

- `X-Queue-Token: <QUEUE_API_TOKEN>`
- `Authorization: Bearer <QUEUE_API_TOKEN>`

If `QUEUE_API_TOKEN` is unset, the worker falls back to `WEBHOOK_SECRET` for backward compatibility.

## Tool Surface

The server exposes grouped tool families rather than one flat surface:

- overview and self-host guidance
- workspace registry and active repo context
- repository read and search
- repository write including workflow-file edits, PR, comment, and workflow dispatch
- branch cleanup and collaboration helpers
- queue, audit, and reviewer loop state

Regenerate the generated tool doc after catalog changes:

```bash
npm run docs:tool-surface
```

The source catalog is [`worker/src/tool-catalog.json`](/d:/VScode/opengpt-github-mcp-worker/worker/src/tool-catalog.json).

## GitHub App Assumptions

Phase 1 assumptions:

- allowlisted repos only
- direct writes only on `agent/*`
- no force-push
- workflow dispatch limited to the allowlisted workflow set, and the target workflow file must define `on.workflow_dispatch`
- repo-specific workflow allowlists can override the global workflow allowlist

Minimum GitHub App permissions:

- Contents: Read and write
- Pull requests: Read and write
- Issues: Read and write
- Actions: Read and write
- Workflows: Read and write
- Metadata: Read only

Recommended webhook events:

- `workflow_run`
- `pull_request`

## Operations

Recommended self-host flow:

1. Push to `main`
2. Let CI deploy `mirror`
3. Verify mirror via `/healthz` or `npm run ops:status`
4. Promote `live` manually

Basic smoke checks after deploy:

1. `GET /healthz`
2. `GET /github/app-installation`
3. Connect a direct MCP client to `/mcp` and `listTools`
4. Connect a ChatGPT custom connector to `/chatgpt/mcp`
5. Create a queue job and verify webhook-driven state transitions

## Security Note

If a private key or webhook secret was pasted into chat or otherwise exposed during setup, rotate it before production use.
