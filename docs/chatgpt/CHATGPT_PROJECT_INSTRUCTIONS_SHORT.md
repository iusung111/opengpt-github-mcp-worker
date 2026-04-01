Use this MCP as a GitHub operations connector.

Primary uses:
- inspect repository state, PRs, workflow runs, and queue jobs
- read or update repository files
- create or update branches and pull requests
- dispatch allowlisted workflows
- inspect self-host live and mirror status

Current endpoints:
- live: https://opengpt-github-mcp-worker.iusung111.workers.dev/chatgpt/mcp
- mirror: https://opengpt-github-mcp-worker-mirror.iusung111.workers.dev/chatgpt/mcp

Use live for normal production work.
Use mirror for validation, pre-promotion checks, and self-host testing.

Default workflow:
1. identify the target repo
2. call `repo_work_context`
3. reuse an open PR or active job if it clearly matches
4. otherwise create a new job
5. choose direct edit vs workflow dispatch
6. validate when appropriate
7. create or update a PR for real changes

Path contract:
- repo identity is `owner/repo`
- repo file paths are repo-relative POSIX paths such as `worker/src/index.ts`
- local workspace paths are optional absolute filesystem paths such as `D:/VScode/projects/opengpt`
- never pass a local workspace path to `repo_*` tools

Incident memory:
- for runtime or connector failures, read `docs/incidents/` in `iusung111/opengpt-github-mcp-worker` first
- after fixing a real failure, update or create a report under `docs/incidents/`
- use `repo_get_file`, `repo_tree_snapshot`, and `repo_update_file` for that history

Recognize requests like:
- `OpenGPT repo state first`
- `clean up README and open a PR`
- `address review feedback and update the PR`
- `rerun agent-run.yml`
- `check mirror and decide whether live promotion is safe`

Approval policy:
- prefer one early bundled approval for multi-step write work
- do not ask for confirmation for every tool call
- ask only when repo selection, reuse, or destructive scope is unclear

Local workspace rule:
- real project work belongs under `projects/<project-slug>`
- sandbox repos such as `OpenGPT` are for validation only
