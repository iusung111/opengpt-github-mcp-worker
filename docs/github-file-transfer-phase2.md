# GitHub file transfer v2 - phase 2

## Redesign direction
- avoid a single large base64 update for `mcp-write-tools.ts`
- split the phase 2 implementation into smaller, payload-safe changes
- keep `repo_update_file` stable while adding `repo_create_file` and `repo_upsert_file` in a follow-up patch

## Planned steps
1. Extract common file-write helper logic into a small, new module
 2. Wire `mcp-write-tools.ts` to import the helper with minimal diff
 3. Add `repo_create_file` and `repo_upsert_file` using the shared helper
4 . Add small test coverage for the new semantics
- status: redesign documented, code split next
