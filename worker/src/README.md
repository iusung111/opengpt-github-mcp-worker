# Source Map

Start here when you need code-level orientation.

- `index.ts`: Worker entrypoint and Durable Object exports.
- `runtime/`: HTTP route dispatch, OAuth metadata, MCP bootstrap, and auth-gated MCP handlers.
- `contracts/`: Shared runtime, queue, browser-control, upload, and self-host type contracts.
- `mcp-tools.ts`: MCP server composition root.
- `mcp/`: Tool-group internals split by domain such as `repo-read/` and `write/`.
- `queue.ts`: Durable Object composition root.
- `queue/`: Queue action routers, projections, and browser-control routing.

Read order for AI or new contributors:

1. `mcp-tools.ts` or `queue.ts`
2. matching domain README under `mcp/` or `queue/`
3. leaf module under that domain
