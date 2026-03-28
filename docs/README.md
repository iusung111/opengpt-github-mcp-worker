# Documentation Index

Use this directory as the operational and integration source of truth for the worker.

## Start Here

- [../README.md](../README.md) for the high-level overview and local setup
- [desktop-fullstack-mcp-roadmap.md](./desktop-fullstack-mcp-roadmap.md) for the desktop-first fullstack MCP implementation roadmap and phase order
- [project-capabilities.example.json](./project-capabilities.example.json) for the `.opengpt/project-capabilities.json` contract example used by the new fullstack tools
- [MCP_ACCESS.md](./MCP_ACCESS.md) for direct `/mcp` deployment behind Cloudflare Access
- [CHATGPT_MCP.md](./CHATGPT_MCP.md) for `/chatgpt/mcp` OAuth/OIDC connector setup
- [TOOL_SURFACE.md](./TOOL_SURFACE.md) for the generated MCP tool catalog

## ChatGPT Docs

- [chatgpt/CHATGPT_PROJECT_INSTRUCTIONS.md](./chatgpt/CHATGPT_PROJECT_INSTRUCTIONS.md)
- [chatgpt/CHATGPT_PROJECT_INSTRUCTIONS_SHORT.md](./chatgpt/CHATGPT_PROJECT_INSTRUCTIONS_SHORT.md)
- [chatgpt/MCP_IDENTIFIER_GUIDANCE.md](./chatgpt/MCP_IDENTIFIER_GUIDANCE.md)
- [chatgpt/CHATGPT_CONNECTOR_INCIDENT_2026-03-22.md](./chatgpt/CHATGPT_CONNECTOR_INCIDENT_2026-03-22.md)

## Operations And Incidents

- [incidents/README.md](./incidents/README.md)
- [incidents/INCIDENT_TEMPLATE.md](./incidents/INCIDENT_TEMPLATE.md)
- [incidents/MCP_TOOL_EXPOSURE_INCIDENT_2026-03-24.md](./incidents/MCP_TOOL_EXPOSURE_INCIDENT_2026-03-24.md)
- [releases/CHANGELOG.md](./releases/CHANGELOG.md)

## Reference

- [reference/test_summary.md](./reference/test_summary.md)
- `reference/test_output.txt`
- `reference/test_verbose.txt`
- [github-file-transfer-phase2.md](./github-file-transfer-phase2.md)

## Maintenance Notes

- Keep the root `README.md` focused on onboarding and top-level operations.
- Put detailed auth, deployment, and incident procedures under `docs/`.
- Prefer relative Markdown links so the docs work in GitHub, local editors, and MCP file reads.
