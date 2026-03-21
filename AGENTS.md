# Repository Instructions

This repository inherits global defaults from `~/.codex/AGENTS.md` and workspace defaults from `D:\VScode\AGENTS.md`. Keep this file focused on repo-specific rules.

## Cloudflare Workers

- Cloudflare Workers guidance may be stale. Retrieve current docs before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, Workers AI, or Agents SDK task.
- Use `https://developers.cloudflare.com/workers/` and `https://docs.mcp.cloudflare.com/mcp`.
- For limits and quotas, read the product's `/platform/limits/` page.
- After changing bindings in `wrangler.jsonc`, run `npm run cf-typegen`.

## Validation

- Minimum validation for code changes: `npm run typecheck`.
- Preferred full validation: `npm run check`.
- Use `npm run test:unit` for focused unit changes.
- Use `npm run test:integration:runtime` when changing runtime HTTP, runtime MCP, or webhook execution behavior.
- Use `npm run test:integration` or `npm run test:all` only when the change surface justifies the extra cost.

## Execution Notes

- Use `npm run dev` for local Workers development.
- Do not treat `npm run deploy` as a validation step.
