# ChatGPT MCP Connector

`/chatgpt/mcp` is the ChatGPT custom connector endpoint.

It is separate from the direct `/mcp` endpoint:

- `/mcp`: Cloudflare Access protected direct MCP access
- `/chatgpt/mcp`: bearer-token OIDC access for ChatGPT custom connectors

Workflow file access goes through the normal repository file tools:

- use `repo_get_file` to read files such as `.github/workflows/ci.yml`
- use `repo_update_file` on an agent branch only for smaller workflow edits
- use `repo_upload_start -> repo_upload_append -> repo_upload_commit` for larger file edits or when ChatGPT web payload limits make single-request writes unreliable
- use `workflow_dispatch` only to run an allowlisted workflow, not to edit its file
- use `workflow_allowlist_inspect` when `workflow_dispatch` fails with `workflow_not_allowlisted`

## Large File Upload Flow

For web ChatGPT or any caller that hits request payload limits, use the streamed upload path instead of sending one large `content_b64` payload.

Recommended sequence:

1. `repo_upload_start`
2. `repo_upload_append` repeated with ordered chunks
3. `repo_upload_commit`
4. `repo_upload_abort` if the upload must be discarded

Operational notes:

- `repo_update_file` remains available for smaller files and compatibility flows.
- upload chunks must be sent in order with matching `chunk_index` and `byte_offset`
- upload sessions expire after a short TTL
- the final commit uses GitHub git data APIs instead of the contents API so the upload can be staged incrementally

Workflow allowlist precedence for dispatch:

- `worker/config/workflow-allowlist.json` is the repo-managed source of truth for committed per-repo allowlist entries
- `GITHUB_ALLOWED_WORKFLOWS_BY_REPO` is merged on top for the same repo
- `GITHUB_ALLOWED_WORKFLOWS` is only the fallback when no repo-specific entry exists

These two paths are not interchangeable.

## Run Console Widget Exposure

This repository does not expose a separate MCP tool named `alarm`, `reminder`, or `notification_open`.

Instead, the interactive web UI is the shared queue widget resource:

- widget URI: `ui://widget/notification-center.html`
- frontend entry points:
  - `public/gui/index.html`
  - `public/gui/app.js`
  - `public/gui/run-console-app.js`
- widget registration:
  - `worker/src/mcp-widget-resources.ts`

The widget is attached through `openai/outputTemplate` metadata on queue and overview tools such as:

- `jobs_list`
- `job_progress`
- `job_event_feed`
- `request_permission_bundle`
- `permission_request_resolve`
- `job_control`
- `incident_bundle_create`
- `self_host_status`

Practical implication for ChatGPT web:

- the widget appears when ChatGPT calls one of the tools above
- there is no standalone "open alarm UI" tool on main right now
- if the model never chooses one of those tools, the widget will not render even though the exposure metadata is present

## Required Config

Set these Worker vars for ChatGPT connector use:

```text
CHATGPT_MCP_AUTH_MODE=oidc
CHATGPT_MCP_ISSUER=<oidc-issuer>
CHATGPT_MCP_AUDIENCE=<expected-audience>
CHATGPT_MCP_JWKS_URL=<jwks-url>
CHATGPT_MCP_ALLOWED_EMAILS=<allowed-email>
```

Optional:

```text
CHATGPT_MCP_JWKS_JSON=<inline-jwks-json>
```

`CHATGPT_MCP_JWKS_JSON` is mainly useful for testing or tightly controlled deployments. In production, prefer `CHATGPT_MCP_JWKS_URL`.

## Connector Setup

Use a new ChatGPT custom connector instead of reusing the old Access-only connector.

- MCP URL: `https://<worker-url>/chatgpt/mcp`
- Auth type: `OAuth`
- OAuth provider: an external OIDC provider that issues bearer tokens with:
  - `iss` matching `CHATGPT_MCP_ISSUER`
  - `aud` matching `CHATGPT_MCP_AUDIENCE`
  - `email` claim present

This Worker validates bearer tokens. It does not act as the OAuth authorization server.

When the MCP needs to edit files under `.github/workflows/`, the GitHub App must have both `Contents: Read and write` and `Workflows: Read and write`.

## Personal Auth0 Setup

If this is a personal MCP and you do not already have an OIDC provider, the simplest path is to create one with Auth0.

### 1. Create an Auth0 tenant

- Sign up for Auth0 and note your tenant domain.
- Example tenant domain: `your-tenant.us.auth0.com`

This tenant domain is the base for your OIDC discovery and JWKS URLs.

### 2. Create an API in Auth0

In the Auth0 dashboard:

1. Open `Applications` -> `APIs`
2. Click `Create API`
3. Set:
   - Name: `OpenGPT MCP API`
   - Identifier: a stable audience value such as `https://opengpt-github-mcp-worker`
   - Signing Algorithm: `RS256`

The API `Identifier` becomes the expected access-token audience for this Worker.

### 3. Create an Auth0 application for ChatGPT

In the Auth0 dashboard:

1. Open `Applications` -> `Applications`
2. Click `Create Application`
3. Choose `Regular Web Application`
4. Save the generated `Client ID`
5. Save the generated `Client Secret` if you plan to use static client credentials in ChatGPT

### 4. Collect issuer and JWKS values

Open your tenant discovery document:

```text
https://<your-auth0-domain>/.well-known/openid-configuration
```

Example:

```text
https://your-tenant.us.auth0.com/.well-known/openid-configuration
```

From that JSON, copy:

- `issuer` -> `CHATGPT_MCP_ISSUER`
- `jwks_uri` -> `CHATGPT_MCP_JWKS_URL`

For Auth0 this is commonly:

```text
CHATGPT_MCP_ISSUER=https://your-tenant.us.auth0.com/
CHATGPT_MCP_JWKS_URL=https://your-tenant.us.auth0.com/.well-known/jwks.json
```

### 5. Set the audience value

Use the Auth0 API Identifier from step 2:

```text
CHATGPT_MCP_AUDIENCE=https://opengpt-github-mcp-worker
```

### 6. Set allowed emails

Start with your own login email only:

```text
CHATGPT_MCP_ALLOWED_EMAILS=you@example.com
```

### 7. Confirm the bearer token identity path

This Worker prefers a JWT bearer token with:

- `iss`
- `aud`
- `email`

But Auth0 may also issue an opaque bearer token for the connector and rely on `userinfo`.

Before switching production traffic, verify at least one of these is true:

- the bearer token is a JWT with valid `iss` and `aud`
- or the bearer token can successfully call Auth0 `userinfo` and return `email`

## Worker Config Example

For a personal Auth0-backed connector, the Worker config usually looks like:

```text
CHATGPT_MCP_AUTH_MODE=oidc
CHATGPT_MCP_ISSUER=https://your-tenant.us.auth0.com/
CHATGPT_MCP_AUDIENCE=https://opengpt-github-mcp-worker
CHATGPT_MCP_JWKS_URL=https://your-tenant.us.auth0.com/.well-known/jwks.json
CHATGPT_MCP_ALLOWED_EMAILS=you@example.com
```

Current tenant example for this project:

```text
CHATGPT_MCP_AUTH_MODE=oidc
CHATGPT_MCP_ISSUER=https://dev-plkp1egugigfyy20.us.auth0.com/
CHATGPT_MCP_AUDIENCE=https://opengpt-github-mcp-worker,https://dev-plkp1egugigfyy20.us.auth0.com/userinfo
CHATGPT_MCP_JWKS_URL=https://dev-plkp1egugigfyy20.us.auth0.com/.well-known/jwks.json
CHATGPT_MCP_ALLOWED_EMAILS=iusung111@gmail.com
```

## ChatGPT OAuth Input Example

When creating the new ChatGPT connector, use:

- MCP URL: `https://<worker-url>/chatgpt/mcp`
- Auth type: `OAuth`
- Authorization URL: `https://<your-auth0-domain>/authorize`
- Token URL: `https://<your-auth0-domain>/oauth/token`
- Scope: `openid profile email offline_access`
- Audience: your Auth0 API Identifier

Current tenant example for this project:

- MCP URL: `https://opengpt-github-mcp-worker.iusung111.workers.dev/chatgpt/mcp`
- Auth type: `OAuth`
- Authorization URL: `https://dev-plkp1egugigfyy20.us.auth0.com/authorize`
- Token URL: `https://dev-plkp1egugigfyy20.us.auth0.com/oauth/token`
- Scope: `openid profile email offline_access`
- Audience: `https://opengpt-github-mcp-worker`

If ChatGPT shows a callback URL during setup, add that exact callback URL to the Auth0 application's allowed callback URLs.

## Exact UI Paths

Use the exact product menus below when collecting values. Do not guess field names.

### Values From Auth0 Discovery JSON

Open this URL in your browser:

```text
https://dev-plkp1egugigfyy20.us.auth0.com/.well-known/openid-configuration
```

Copy the values from these exact JSON keys:

- `authorization_endpoint` -> ChatGPT `Authorization URL`
- `token_endpoint` -> ChatGPT `Token URL`
- `issuer` -> Worker `CHATGPT_MCP_ISSUER`
- `jwks_uri` -> Worker `CHATGPT_MCP_JWKS_URL`

### Values From Auth0 Dashboard

For the API audience:

1. Auth0 Dashboard
2. Left menu: `Applications`
3. Submenu: `APIs`
4. Click your API
5. Copy the `Identifier` field

Use that value for:

- Worker `CHATGPT_MCP_AUDIENCE`
- ChatGPT `Audience`

For OAuth client credentials:

1. Auth0 Dashboard
2. Left menu: `Applications`
3. Submenu: `Applications`
4. Click the application you created for ChatGPT
5. Open the `Settings` tab
6. Copy:
   - `Client ID`
   - `Client Secret`

Use those values for:

- ChatGPT `Client ID`
- ChatGPT `Client Secret`

For the callback URL:

1. Create or edit the ChatGPT OAuth connector
2. Copy the callback URL shown by ChatGPT during setup
3. Go to Auth0 Dashboard
4. Left menu: `Applications`
5. Submenu: `Applications`
6. Click the ChatGPT application
7. Open the `Settings` tab
8. Paste the ChatGPT callback URL into `Allowed Callback URLs`
9. Click `Save Changes`

For the allowed email:

- Use the exact email address that should be allowed to use the connector
- This is not read from Auth0 UI
- It is an operator-managed allowlist value for the Worker

Current value for this project:

```text
CHATGPT_MCP_ALLOWED_EMAILS=iusung111@gmail.com
```

### Values In ChatGPT App Creation

When creating the new connector in ChatGPT Developer mode, fill these exact inputs:

1. ChatGPT
2. `Settings`
3. `Apps`
4. `Advanced settings`
5. `Developer mode`
6. `Create app`
7. Enter:
   - `MCP URL`: `https://opengpt-github-mcp-worker.iusung111.workers.dev/chatgpt/mcp`
   - `Auth type`: `OAuth`
   - `Authorization URL`: from Auth0 discovery `authorization_endpoint`
   - `Token URL`: from Auth0 discovery `token_endpoint`
   - `Client ID`: from Auth0 `Applications` -> `Applications` -> app -> `Settings`
   - `Client Secret`: from Auth0 `Applications` -> `Applications` -> app -> `Settings`
   - `Scope`: `openid profile email offline_access`
   - `Audience`: from Auth0 `Applications` -> `APIs` -> API -> `Identifier`

## Operator Default

When explaining OAuth setup for this project, always provide:

- the exact product name
- the exact menu path
- the exact field label
- whether the value comes from ChatGPT, Auth0 dashboard, Auth0 discovery JSON, or the Worker config

Do not describe a value without also saying exactly where to retrieve it.

## Migration Sequence

1. Create the Auth0 API and application
2. Fill `CHATGPT_MCP_*` values in the Worker
3. Deploy and confirm `/healthz` reports `chatgpt_mcp_auth_mode: "oidc_email_allowlist"`
4. Create a new ChatGPT connector pointing to `/chatgpt/mcp`
5. Verify read-only calls first
6. Re-enable auth on `/mcp` after the OAuth connector is confirmed working

## Runtime Behavior

- unauthenticated `GET` / `HEAD` / `OPTIONS` to `/chatgpt/mcp`: bootstrap `200 OK`
- unauthenticated MCP bootstrap RPC such as `initialize`, `notifications/initialized`, `tools/list`: allowed during connector setup
- unauthenticated `tools/call`: `401` with `WWW-Authenticate` Bearer challenge and protected-resource metadata URL
- missing bearer token: `401 unauthorized`
- invalid signature, issuer, audience, or expiry: `401 unauthorized`
- email not in `CHATGPT_MCP_ALLOWED_EMAILS`: `403 forbidden`
- empty `CHATGPT_MCP_ALLOWED_EMAILS`: deny all

## Preflight Checklist

Before creating or rotating a ChatGPT connector, verify all of the following:

1. `GET /healthz` returns `chatgpt_mcp_auth_mode: "oidc_email_allowlist"`
2. `GET /.well-known/oauth-protected-resource/chatgpt/mcp` returns `200`
3. `GET /chatgpt/mcp` returns `200`
4. unauthenticated `POST /chatgpt/mcp` with `initialize` returns `200`
5. unauthenticated `POST /chatgpt/mcp` with `tools/call` returns `401` and includes `WWW-Authenticate`
6. Auth0 application has:
   - `Authorization Code` enabled
   - the ChatGPT callback URL in `Allowed Callback URLs`
7. ChatGPT OAuth fields use:
   - `Authorization URL` from Auth0 discovery `authorization_endpoint`
   - `Token URL` from Auth0 discovery `token_endpoint`
   - `Scope` set to `openid profile email offline_access`
   - `Client ID` and `Client Secret` from the Auth0 application

## Known Failure Path

The March 22, 2026 incident was not a single bug. The connector failed across multiple layers:

1. `/mcp` was still designed for Cloudflare Access headers, not ChatGPT OAuth
2. `/chatgpt/mcp` initially rejected generic URL probes and header-light `initialize` requests
3. Auth0 `authorization_code` was not enabled in the application advanced settings
4. Auth0 callback URL was not registered
5. Auth0 issued `userinfo` audience / opaque bearer behavior that the Worker did not initially accept

Reference report:

- [ChatGPT Connector Incident 2026-03-22](./chatgpt/CHATGPT_CONNECTOR_INCIDENT_2026-03-22.md)
- [Incident report index](./incidents/README.md)
- [MCP Tool Exposure Incident 2026-03-24](./incidents/MCP_TOOL_EXPOSURE_INCIDENT_2026-03-24.md)

## Incident Memory Rule

For repeated connector, routing, auth, live/mirror, or tool-surface failures:

1. read the relevant files under `docs/incidents/` first
2. reproduce the issue with raw MCP or HTTP requests before assuming the UI diagnosis is correct
3. after fixing the issue, create or update a report under `docs/incidents/`
4. prefer self-repo MCP file tools for this:
   - `repo_get_file`
   - `repo_tree_snapshot`
   - `repo_update_file`
   - `repo_upload_start`
   - `repo_upload_append`
   - `repo_upload_commit`

## Verification

After deployment, confirm `/healthz` reports:

```json
{
  "chatgpt_mcp_auth_mode": "oidc_email_allowlist",
  "chatgpt_allowed_emails_count": 1
}
```

Then reconnect ChatGPT with a new connector and verify:

1. `jobs_list`
2. `repo_list_tree(owner="iusung111", repo="OpenGPT", path="", recursive=false)`
3. `repo_get_file(owner="iusung111", repo="OpenGPT", path="README.md")`
4. `repo_get_file(owner="iusung111", repo="OpenGPT", path=".github/workflows/agent-run.yml")`
