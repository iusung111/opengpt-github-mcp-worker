# MCP Tool Exposure Incident 2026-03-24

## Summary

OpenGPT and OpenGPT_mirror appeared to expose many callable MCP tools through higher-level `link_*` resources, but several calls returned `Resource not found`.

The Worker itself was not missing those tools. Raw MCP `tools/list` and `tools/call` were consistent on both live and mirror. The confirmed runtime defect was inside `self_host_status`, where cross-endpoint health checks failed with Cloudflare error `1042`.

Final state:

- raw MCP tool listing and calling are aligned on live and mirror
- `jobs_list`, `workspace_list`, and `repo_tree_snapshot` are callable on both deployments
- live-to-mirror and mirror-to-live health checks succeed from `self_host_status`

## Symptoms

- higher-level `api_tool.list_resources` showed many `/OpenGPT/link_*/*` and `/OpenGPT_mirror/link_*/*` entries
- some direct calls succeeded:
  - `help`
  - `self_host_status`
  - some `workspace_list`
- some direct calls failed in the client surface:
  - `jobs_list`
  - `repo_tree_snapshot`
  - some `workspace_list`
- `self_host_status` showed:
  - live fetching mirror `/healthz` -> `404 / error code: 1042`
  - mirror fetching live `/healthz` -> `404 / error code: 1042`

## Reproduction

Reproduced directly against deployed MCP endpoints:

1. `POST /mcp` with `tools/list`
2. `POST /mcp` with `tools/call` for:
   - `help`
   - `self_host_status`
   - `workspace_list`
   - `jobs_list`
   - `repo_tree_snapshot`
3. compare live and mirror results
4. inspect `self_host_status.data.live.healthz` and `self_host_status.data.mirror.healthz`

Observed result before the fix:

- raw `tools/list` and raw `tools/call` were already consistent
- only cross-worker health fetches failed, with `1042`

## Root Cause

There were two different layers involved.

1. Confirmed runtime defect:
   - `self_host_status` performs Worker-side `fetch()` calls from one `workers.dev` deployment to the other
   - Cloudflare blocks same-zone Worker-to-Worker fetches without the `global_fetch_strictly_public` compatibility flag
   - Cloudflare returns error `1042` for that case

2. Inferred client-side mismatch:
   - the reported `Resource not found` behavior did not reproduce at the raw Worker MCP layer
   - the failing surface was therefore most consistent with stale higher-level discovery metadata or stale `link_*` resource mapping in the client layer
   - the Worker router, tool registry, and dispatcher were not missing `jobs_list`, `workspace_list`, or `repo_tree_snapshot`

## Remediation Applied

- added `global_fetch_strictly_public` to `wrangler.jsonc`
- bumped MCP server version from `0.2.1` to `0.2.2` so clients can refresh discovery metadata
- redeployed mirror and live from the same GitHub commit:
  - `652cce62cf2d87b4238211cfef7eb8efd5fd806f`

## Verification

Commands used:

```text
npm run typecheck
npx vitest run worker/test/runtime-http worker/test/runtime-mcp --sequence.concurrent=false
node worker/scripts/cloudflare-deploy.mjs --deploy-target mirror --deploy-url https://opengpt-github-mcp-worker-mirror.iusung111.workers.dev
node worker/scripts/cloudflare-deploy.mjs --deploy-target live --deploy-url https://opengpt-github-mcp-worker.iusung111.workers.dev
```

Deployed verification:

- live `/healthz` -> `200`, `release_commit_sha=652cce62cf2d87b4238211cfef7eb8efd5fd806f`
- mirror `/healthz` -> `200`, `release_commit_sha=652cce62cf2d87b4238211cfef7eb8efd5fd806f`
- live raw MCP:
  - `help` OK
  - `self_host_status` OK
  - `workspace_list` OK
  - `jobs_list` OK
  - `repo_tree_snapshot` OK
- mirror raw MCP:
  - `help` OK
  - `self_host_status` OK
  - `workspace_list` OK
  - `jobs_list` OK
  - `repo_tree_snapshot` OK
- cross-health inside `self_host_status`:
  - live -> mirror `200`
  - mirror -> live `200`

## Prevention / Follow-Up

- for future MCP exposure incidents, verify raw MCP `tools/list` and `tools/call` first before blaming the registry
- if a client shows `link_*` resources but raw MCP is healthy, treat it as a discovery/cache problem until proven otherwise
- keep all new operational failures under `docs/incidents/`
- read existing incident files from MCP before repeating deep investigation
