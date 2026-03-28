# OpenGPT GitHub MCP Worker

Remote GitHub MCP server for ChatGPT Developer mode, deployed on Cloudflare Workers.

- Direct MCP endpoint: `/mcp`
- ChatGPT connector endpoint: `/chatgpt/mcp`
- Runtime: Cloudflare Workers + Durable Objects
- Access model:
  - `/mcp` uses Cloudflare Access
  - `/chatgpt/mcp` uses OAuth/OIDC bearer auth

## Documentation

Start with the docs hub: [docs/README.md](./docs/README.md)

Primary entry points:

- [Access and deployment](./docs/MCP_ACCESS.md)
- [ChatGPT connector auth](./docs/CHATGPT_MCP.md)
- [Tool surface](./docs/TOOL_SURFACE.md)
- [Desktop-first fullstack roadmap](./docs/desktop-fullstack-mcp-roadmap.md)
- [Project capability contract example](./docs/project-capabilities.example.json)
- [Incident reports](./docs/incidents/README.md)
- [Release history](./docs/releases/CHANGELOG.md)

## Repository Layout

- `.github/`
- `docs/`
- `public/`
- `worker/`
- `README.md`
- `package.json`
- `wrangler.jsonc`

## Production Model

- `push main` runs `cloudflare-ci`
- successful CI auto-deploys `mirror`
- `live` is promoted manually through `cloudflare-self-deploy`
- `/mcp` stays behind Cloudflare Access
- `/chatgpt/mcp` stays behind OAuth/OIDC-aware ChatGPT connector auth

Deploying the Worker alone is not the full production setup. The deployment also depends on the configured Cloudflare Access and OAuth/OIDC policy.

## Quick Start

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars`
3. Add required Worker secrets:
   - `npx wrangler secret put GITHUB_APP_PRIVATE_KEY_PEM`
   - `npx wrangler secret put WEBHOOK_SECRET`
4. Run `npm run check`
5. Start local development with `npm run dev`

## Validation

Preferred commands:

```bash
npm run check
```

Focused commands:

```bash
npm run typecheck
npm run test:unit
npm run test:integration:runtime
npm run ops:status
npm run docs:tool-surface
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

Target repos can opt into the desktop-first fullstack tool surface with
`.opengpt/project-capabilities.json` plus the standard GitHub workflows
`opengpt-exec.yml` and `opengpt-package.yml`.

## Runtime Endpoints

- GUI root: `https://<worker-url>/` redirects to `/gui/`
- Static GUI: `https://<worker-url>/gui/`
- Direct MCP: `https://<worker-url>/mcp`
- ChatGPT MCP: `https://<worker-url>/chatgpt/mcp`
- Webhook: `https://<worker-url>/webhooks/github`
- Health: `https://<worker-url>/healthz`
- Queue API: `/queue/*`

Queue routes are private. Authenticate with either:

- `X-Queue-Token: <QUEUE_API_TOKEN>`
- `Authorization: Bearer <QUEUE_API_TOKEN>`

If `QUEUE_API_TOKEN` is unset, the worker falls back to `WEBHOOK_SECRET` for backward compatibility.

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
