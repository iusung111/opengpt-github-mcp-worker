## Summary

- root cause addressed:
- minimal diff rationale:
- affected surfaces:

## Required verification

- [ ] `npm run cf-typegen`
- [ ] `npm run docs:tool-surface:check`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `node worker/scripts/check-chatgpt-mcp-contract.mjs`
- [ ] `node worker/scripts/check-route-canonicalization.mjs`
- [ ] mirror deploy completed for the exact commit under review
- [ ] `GET /healthz` on mirror reports `deploy_environment=mirror`
- [ ] `GET /healthz` on mirror reports `release_commit_sha == expected_commit_sha`
- [ ] `node worker/scripts/smoke-chatgpt-mcp.mjs` passed against mirror

## Merge stop rules

- [ ] do not merge if `/chatgpt/mcp` `tools/list` hides all write-capable tools
- [ ] do not merge if `mcp_public_blocked_count > 0`
- [ ] do not merge if `mcp_public_blocked_tool_call_count > 0`
- [ ] do not merge if mirror SHA is stale or mismatched after deploy success
- [ ] do not merge if route or surface contract drift is still open
- [ ] do not merge on workflow success alone without functional mirror smoke evidence

## Review notes

- mirror verification evidence:
- smoke output artifact or log link:
- remaining risk:
