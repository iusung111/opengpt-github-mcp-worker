# MCP Path Mixing Incident 2026-04-01

## Summary

Web ChatGPT repeatedly mixed repo file paths, connector handles, and local workspace paths during MCP read and write flows. The result was frequent avoidable failures, especially when a local absolute path or host-specific workspace hint was reused as if it were a repo file path.

## Symptoms

- `workspace_resolve` suggested host-specific absolute paths such as `/home/uieseong/workspace/projects/OpenGPT`
- repo read and write tools accepted ambiguous `path` strings until they failed with generic `unsafe path` errors
- repeated retries reused local filesystem paths like `D:\VScode\...` or `/home/...` against `repo_*` tools
- failure messages did not clearly explain the difference between a repo file path and a local workspace path

## Exact Reproduction

1. Connect web ChatGPT to `/chatgpt/mcp`
2. Call `workspace_resolve` for `iusung111/OpenGPT`
3. Reuse the suggested local absolute path as the `path` argument to `repo_get_file` or `repo_update_file`
4. Observe repeated failed MCP calls with non-corrective path errors

## Root Cause

- The workspace helper returned a host-specific absolute default path instead of repo-first guidance
- Repo tool path validation did not explicitly enforce repo-relative POSIX semantics
- Workspace path validation and repo path validation collapsed into generic failure wording in the user-visible response path
- ChatGPT-facing instructions did not clearly separate repo identity, repo file paths, and optional local workspace paths

## Remediation Applied

- Changed `workspace_resolve` to return repo-first guidance with `recommended_workspace_relative_path` instead of `default_workspace_path`
- Normalized registered workspace paths before storing or returning them
- Enforced repo-relative POSIX validation for `repo_*` path arguments and rejected absolute Windows or POSIX local paths early
- Added distinct error codes and corrective messages for invalid repo paths vs invalid workspace paths
- Updated ChatGPT/operator instructions to separate repo identity, repo file paths, and local workspace metadata

## Verification

- `npm run typecheck`
- `npx vitest run worker/test/queue-workspaces.spec.ts worker/test/queue-store.spec.ts worker/test/read-navigation.spec.ts worker/test/runtime-mcp --sequence.concurrent=false`
- `npm run docs:tool-surface:check`

## Prevention / Follow-up Rules

- Keep the repo as the primary MCP source of truth and treat local workspace paths as optional metadata only
- Do not return host-specific absolute defaults from repo-selection helpers
- Keep repo file path validation corrective and explicit
- When new connector regressions appear, record the path category involved: repo identity, repo file path, or local workspace path
