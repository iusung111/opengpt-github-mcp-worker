# ChatGPT MCP Contract And Mirror Guard Policy

This document is the operator-facing contract that the new guard scripts enforce.

## Contract scope

The guarded surface is the public ChatGPT connector route:

- route: `/chatgpt/mcp`
- runtime profile policy: `direct_full`
- widget resource URI: `ui://widget/notification-center.html`
- widget mime type: `text/html;profile=mcp-app`

## Required exposure contract

The pre-merge contract check requires the following to remain true:

- `tools/list` is available on `/chatgpt/mcp`
- at least one write-capable repository tool is exposed in `tools/list`
- the queue widget continues to attach through the documented widget resource
- `self_host_status` remains part of the widget-aware overview surface
- unauthenticated `tools/call` still returns `401` with a Bearer challenge instead of silently drifting into a blocked public preflight policy

## Mirror verification contract

The mirror smoke test requires the following to remain true after deploy:

- `GET /healthz` returns `200`
- `deploy_environment == mirror`
- `release_commit_sha == expected_commit_sha` when an expected SHA is supplied
- `GET /chatgpt/mcp` returns `200`
- unauthenticated `initialize` returns `200`
- unauthenticated `tools/list` returns `200`
- `tools/list` exposes at least one write-capable tool from the maintained candidate set
- `mcp_public_blocked_count == 0`
- `mcp_public_blocked_tool_call_count == 0`

## Canonical routing contract

The runtime router guard treats the following as canonical expectations:

- `/` redirects to `/gui/`
- `/gui` and `/gui/` stay delegated to the static asset layer instead of being reimplemented in the runtime router
- `/mcp`, `/chatgpt/mcp`, `/webhooks/github`, `/queue/`, `/gui/api/`, and `/healthz` remain runtime-owned paths

## Merge stop rules

Do not merge when any of the following remain true:

- mirror smoke is missing for the commit under review
- mirror health reports the wrong `release_commit_sha`
- `tools/list` no longer exposes a write-capable tool on `/chatgpt/mcp`
- blocked counters increased above zero
- route or widget contract drift is still open
- workflow success exists without functional mirror verification evidence
