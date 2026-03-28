# Direct MCP Access Deployment

`/mcp` is the direct MCP endpoint for Cloudflare Access protected clients.

If you are configuring a ChatGPT custom connector, use [CHATGPT_MCP.md](./CHATGPT_MCP.md) instead. ChatGPT should not be pointed at the Access-only `/mcp` route.

## Recommended Production Setup

1. Deploy the Worker.
2. Put a Cloudflare Access application in front of the Worker hostname or the `/mcp` route.
3. Configure the Access identity provider and policy for the intended users.
4. Keep `MCP_REQUIRE_ACCESS_AUTH=true` in deployed environments.
5. Narrow access with one or both of:
   - `MCP_ALLOWED_EMAILS`
   - `MCP_ALLOWED_EMAIL_DOMAINS`
6. Store those allowlist values in GitHub Actions secrets or repository variables so `cloudflare-self-deploy` injects them during deploy.

## Recommended Current Pattern

For a single-user deployment, use:

```text
MCP_ALLOWED_EMAILS=<your-access-email>
MCP_ALLOWED_EMAIL_DOMAINS=
```

Prefer exact email allowlisting unless there is a clear need to admit a full domain.

## Deploy-Time Source Of Truth

`cloudflare-self-deploy` resolves allowlist values in this order:

1. GitHub Actions secrets
2. GitHub repository variables
3. Defaults in `wrangler.jsonc`

This lets you keep strict production values out of the committed config.

## Local Development

For local development without Cloudflare Access, set `MCP_REQUIRE_ACCESS_AUTH=false` in `.dev.vars`.

## Runtime Behavior

- when `MCP_REQUIRE_ACCESS_AUTH=true`, the Worker requires Cloudflare Access identity headers on `/mcp`
- when Access headers are present and no allowlist is configured, any Access-authenticated identity is allowed
- when allowlists are configured, the identity email must match one of the configured emails or domains
- `/healthz`, `/webhooks/github`, and `/queue/*` are not governed by the MCP Access check

## Verification

After mirror or live deployment, confirm `/healthz` reports the expected mode:

```json
{
  "mcp_access_auth_required": true,
  "mcp_access_mode": "email_or_domain_allowlist"
}
```

Also confirm the allowlist counts match the intended configuration.

For general host smoke checks, confirm the Worker root does not return a JSON `404` anymore:

- `GET /` should redirect to `/gui/`
- `GET /gui/` should return the static GUI
