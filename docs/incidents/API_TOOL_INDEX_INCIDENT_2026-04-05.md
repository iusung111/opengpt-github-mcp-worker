# API Tool Index Incident 2026-04-05

## Summary

`repo_tool_index_lookup` returned an effectively empty API tool index for self-repo queries such as `query="api"` because `tool_paths` did not include the real MCP implementation files under `worker/src/mcp/...`.

The tool catalog fallback still exposed matching `tool_entries` for the self repo in some deployed environments, but the path-oriented half of the index was incomplete and could appear empty or misleading in callers that relied on implementation paths.

## Symptoms

- `repo_tool_index_lookup` with `repo_key=iusung111/opengpt-github-mcp-worker` and `query="api"` returned no implementation paths
- API-related MCP implementation files such as `worker/src/mcp/fullstack/api.ts` were absent from `tool_paths`
- read-navigation classification treated `worker/src/mcp/...` files as generic `source` instead of `tool`
- callers that expected the tool index to point to API implementation files saw an empty or partial result

## Exact Reproduction

1. Call `repo_tool_index_lookup`
2. Use:
   - `repo_key=iusung111/opengpt-github-mcp-worker`
   - `query=api`
3. Observe that API tool names may still be present in `tool_entries`, but `tool_paths` does not include `worker/src/mcp/fullstack/api.ts`

## Root Cause

- `buildPathScopedIndex(..., "tool", ...)` only included files where `classifyReadPath(path) === "tool"`
- `classifyReadPath()` recognized `tool-catalog` files and `mcp-*.ts` filenames, but not nested implementation files under `worker/src/mcp/...` or `worker/src/runtime/mcp/...`
- as a result, the path-scoped tool index excluded the real implementation files for API, repo-read, and related MCP modules

## Remediation Applied

- expanded tool classification so paths containing `/mcp/` are treated as `tool`
- added unit coverage for nested MCP implementation paths
- added runtime MCP coverage verifying that `repo_tool_index_lookup(query="api")` returns:
  - `tool_paths` including `worker/src/mcp/fullstack/api.ts`
  - `tool_entries` including `api_request_run`

## Verification

Commands used:

```text
npm run typecheck
npx vitest run worker/test/read-navigation.spec.ts worker/test/runtime-mcp/02-surface-catalog.spec.ts
npm run test:integration:runtime -- --runInBand
```

Verified result:

- `classifyReadPath("worker/src/mcp/fullstack/api.ts") === "tool"`
- `repo_tool_index_lookup(query="api")` now returns `worker/src/mcp/fullstack/api.ts` in `tool_paths`
- integration runtime suite passes with the new coverage in place

## Prevention / Follow-up Rules

- when extending the MCP surface, treat nested `worker/src/mcp/...` implementation files as first-class tool paths
- keep `tool_entries` and `tool_paths` aligned so callers do not see a name-only index without implementation paths
- add a focused runtime test whenever a new tool domain is expected to appear in `repo_tool_index_lookup`
