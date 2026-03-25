# MCP Identifier Guidance

## Stable identifiers

Use these as stable identifiers for GPT and MCP operations:

- repo key such as `iusung111/opengpt-github-mcp-worker`
- MCP route such as `/mcp` or `/chatgpt/mcp`
- tool name such as `repo_get_file`, `repo_search_code`, or `workflow_dispatch`

## Ephemeral connector handles

Do not treat connector resource handles such as `link_<id>` or full connector paths like `/OpenGPT/link_<id>/...` as stable identifiers.

Those values are session-scoped connector handles and may change after reconnect, approval refresh, mirror/live switching, or a new ChatGPT session.

## Operational rule

For documentation, automation, and GPT guidance, identify MCP access by repo key + route + tool name. Do not persist or automate against a full connector resource path that includes `link_<id>`.
