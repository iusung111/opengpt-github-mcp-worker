# ChatGPT Widget Resource Cache Incident 2026-03-29

## Summary

ChatGPT web returned a `resource not found` style error for the Run Console widget after disconnecting and reconnecting the MCP connector, even though the live Worker still exposed the widget resource correctly over raw MCP.

The confirmed runtime state was:

- live `/chatgpt/mcp` still listed `ui://widget/notification-center.html`
- live `/chatgpt/mcp` still served `resources/read` for that URI
- the failure pattern was therefore most consistent with stale client-side discovery metadata after tool and widget exposure changes

## Symptoms

- ChatGPT web: reconnect connector, start a new chat, ask for `run_console_open`
- ChatGPT web reports that the widget resource does not exist
- raw MCP checks against the same live deployment still return the widget resource and HTML successfully

## Reproduction

Raw reproduction against the deployed ChatGPT MCP endpoint:

1. `POST /chatgpt/mcp` with `initialize`
2. `POST /chatgpt/mcp` with `resources/list`
3. `POST /chatgpt/mcp` with `resources/read` for `ui://widget/notification-center.html`

Observed result:

- `initialize` returned `200`
- `resources/list` returned the widget resource
- `resources/read` returned the widget HTML and `/gui/app.js` reference

## Root Cause

The Worker registry was not missing the widget resource.

The more likely failure was stale discovery metadata inside the ChatGPT connector session after recent MCP tool and widget exposure changes. The MCP server version was still `0.2.2`, so clients had no version-level signal to refresh their cached discovery state.

## Remediation Applied

- bumped the MCP server version from `0.2.2` to `0.2.3`
- kept the widget URI and resource registration unchanged
- recorded the incident so future connector regressions start with raw MCP verification before assuming the Worker stopped exposing the resource

## Verification

Commands used locally:

```text
npm run typecheck
npm run test:integration:runtime -- worker/test/runtime-mcp.spec.ts
```

Raw live MCP verification before deployment:

```text
POST https://opengpt-github-mcp-worker.iusung111.workers.dev/chatgpt/mcp initialize
POST https://opengpt-github-mcp-worker.iusung111.workers.dev/chatgpt/mcp resources/list
POST https://opengpt-github-mcp-worker.iusung111.workers.dev/chatgpt/mcp resources/read uri=ui://widget/notification-center.html
```

Expected final state after deployment:

- live `initialize` reports `serverInfo.version = 0.2.3`
- ChatGPT reconnects against the refreshed discovery metadata
- `run_console_open` resolves the widget resource instead of failing with `resource not found`

## Prevention / Follow-Up

- when ChatGPT web reports widget or tool resources missing, verify raw `/chatgpt/mcp` first
- if raw `resources/list` and `resources/read` succeed, treat the issue as a client discovery/cache problem until proven otherwise
- bump MCP server version when widget or tool exposure changes need to invalidate stale client discovery state
