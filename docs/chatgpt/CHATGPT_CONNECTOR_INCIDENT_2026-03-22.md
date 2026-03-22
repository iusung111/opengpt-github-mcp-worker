# ChatGPT Connector Incident 2026-03-22

## Summary

ChatGPT custom connector setup repeatedly failed even after OAuth login succeeded.

The issue was resolved after fixing both configuration and runtime compatibility gaps on the Worker and Auth0 sides.

Final state:

- ChatGPT connector setup succeeds against `/chatgpt/mcp`
- Auth0 OAuth login succeeds
- Worker accepts ChatGPT bootstrap requests and bearer-authenticated tool calls

## User-Visible Symptoms

- `401 unauthorized`
- `missing Cloudflare Access identity headers`
- `OAuth 구성 가져오기 오류`
- `MCP server ... does not implement OAuth`
- `연결을 설정하는데 오류가 발생했습니다`

## Root Cause Path

This was a layered failure, not a single defect.

1. Direct `/mcp` assumed Cloudflare Access identity headers and was incompatible with ChatGPT OAuth.
2. `/chatgpt/mcp` initially behaved like a strict MCP endpoint rather than a connector-friendly bootstrap endpoint.
3. ChatGPT URL validation and MCP bootstrap requests arrived without the exact `Accept` headers expected by the handler.
4. Auth0 application configuration was incomplete:
   - `Authorization Code` grant was not enabled
   - ChatGPT callback URL was not registered
5. Auth0 issued bearer tokens that did not always match the original Worker assumption:
   - token audience could be `https://dev-plkp1egugigfyy20.us.auth0.com/userinfo`
   - bearer token could require `userinfo` lookup instead of direct JWT `email` claim extraction

## Confirmed Failure Sequence

1. ChatGPT tried to use `/mcp`
2. Worker required Cloudflare Access headers and returned `missing Cloudflare Access identity headers`
3. New `/chatgpt/mcp` connector was introduced
4. ChatGPT probe and bootstrap requests still failed because the endpoint was too strict
5. Auth0 login succeeded, but connector setup still failed during post-login MCP setup
6. Runtime compatibility fixes were added until the full sequence succeeded

## Remediation Applied

### Worker

- Added separate ChatGPT connector path: `/chatgpt/mcp`
- Added OIDC configuration vars for ChatGPT connector auth
- Added bootstrap `200 OK` response for unauthenticated `GET` / `HEAD` / `OPTIONS`
- Added OAuth protected resource metadata endpoint:
  - `/.well-known/oauth-protected-resource`
  - `/.well-known/oauth-protected-resource/chatgpt/mcp`
- Added `WWW-Authenticate` Bearer challenge with `resource_metadata`
- Allowed unauthenticated MCP bootstrap methods before actual tool execution
- Normalized missing `Accept` headers for ChatGPT MCP POST bootstrap requests
- Accepted Auth0 `userinfo` audience in `CHATGPT_MCP_AUDIENCE`
- Added fallback from JWT validation to Auth0 `userinfo` lookup for opaque bearer tokens

### Auth0

- Enabled `Authorization Code` grant in application advanced settings
- Registered ChatGPT callback URL in `Allowed Callback URLs`
- Confirmed login and refresh-token exchange success in Auth0 logs

## Preventive Controls

Before future connector changes, run this checklist in order:

1. Verify `GET /healthz`
   - `chatgpt_mcp_auth_mode` must be `oidc_email_allowlist`
2. Verify `GET /chatgpt/mcp`
   - must return `200`
3. Verify `GET /.well-known/oauth-protected-resource/chatgpt/mcp`
   - must return `200`
4. Verify unauthenticated `initialize`
   - `POST /chatgpt/mcp` with `initialize` must return `200`
5. Verify unauthenticated `tools/call`
   - must return `401` with `WWW-Authenticate`
6. Verify Auth0 application
   - `Authorization Code` enabled
   - ChatGPT callback URL registered
   - `Client ID` / `Client Secret` copied from the correct app
7. Verify connector inputs
   - `MCP URL`
   - `Authorization URL`
   - `Token URL`
   - `Scope`
   - `Client ID`
   - `Client Secret`
8. Verify Auth0 logs during a live setup attempt
   - login success
   - token exchange success

## Follow-Up Risk

`/mcp` is currently configured with `MCP_REQUIRE_ACCESS_AUTH=false` as a temporary operational workaround from the same incident path.

That should be restored to protected mode after confirming:

- ChatGPT connector remains stable
- `/chatgpt/mcp` is the only path used by ChatGPT
- direct `/mcp` callers still have a valid Cloudflare Access path
