# Documentation Index

Use this directory as the operational and integration source of truth for the worker.

## Human Quick Path

Read these in order when you need to operate or extend the system:

1. [../README.md](../README.md)
2. [RUN_CONSOLE.md](./RUN_CONSOLE.md)
3. [MCP_ACCESS.md](./MCP_ACCESS.md)
4. [CHATGPT_MCP.md](./CHATGPT_MCP.md)
5. [releases/CHANGELOG.md](./releases/CHANGELOG.md)

## AI Quick Path

Read these in order when you need repository context fast:

1. [../README.md](../README.md)
2. [TOOL_SURFACE.md](./TOOL_SURFACE.md)
3. [RUN_CONSOLE.md](./RUN_CONSOLE.md)
4. [project-capabilities.example.json](./project-capabilities.example.json)
5. [desktop-fullstack-mcp-roadmap.md](./desktop-fullstack-mcp-roadmap.md)

## System Guides

- [RUN_CONSOLE.md](./RUN_CONSOLE.md) for mission control, lane orchestration, YOLO guardrails, and the modular GUI
- [desktop-fullstack-mcp-roadmap.md](./desktop-fullstack-mcp-roadmap.md) for the longer desktop-first fullstack roadmap
- [project-capabilities.example.json](./project-capabilities.example.json) for the `.opengpt/project-capabilities.json` contract example
- [TOOL_SURFACE.md](./TOOL_SURFACE.md) for the generated MCP tool catalog

## Auth And Deploy

- [MCP_ACCESS.md](./MCP_ACCESS.md) for direct `/mcp` deployment behind Cloudflare Access
- [CHATGPT_MCP.md](./CHATGPT_MCP.md) for `/chatgpt/mcp` OAuth or OIDC connector setup
- [releases/CHANGELOG.md](./releases/CHANGELOG.md) for shipped operational changes

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

- Keep [../README.md](../README.md) focused on onboarding, validation, and production shape.
- Use `docs/README.md` as the stable routing page for people and AI.
- Put detailed auth, deploy, incident, and console behavior here under `docs/`.
- Prefer relative Markdown links so the docs work in GitHub, local editors, and MCP file reads.
