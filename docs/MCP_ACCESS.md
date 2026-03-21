# MCP Access Deployment

`/mcp` is intended to be exposed through Cloudflare Access in deployed environments.

## Recommended Setup

1. Deploy the Worker normally.
2. Create a Cloudflare Access application protecting the Worker hostname or the `/mcp` route.
3. Configure the identity provider and Access policy for the users who should be able to connect.
4. Keep `MCP_REQUIRE_ACCESS_AUTH=true` in deployed environments.
5. Optionally narrow access further with:
   - `MCP_ALLOWED_EMAILS`
   - `MCP_ALLOWED_EMAIL_DOMAINS`
6. Store the allowlist in GitHub Actions secrets or repository variables so `cloudflare-self-deploy` can inject it during deploy.

## Local Development

For local development, set `MCP_REQUIRE_ACCESS_AUTH=false` in `.dev.vars` if Cloudflare Access is not present.

## Runtime Behavior

- when `MCP_REQUIRE_ACCESS_AUTH=true`, the Worker requires Cloudflare Access identity headers on `/mcp`
- when Access headers are present and no allowlist is configured, any Access-authenticated identity is allowed
- when allowlists are configured, the identity email must match one of the configured emails or domains
- `/healthz`, `/webhooks/github`, and `/queue/*` are not governed by the MCP Access check
- `cloudflare-self-deploy` prefers `MCP_ALLOWED_EMAILS` and `MCP_ALLOWED_EMAIL_DOMAINS` from GitHub Actions secrets, then repository variables, before falling back to the empty defaults in `wrangler.jsonc`
