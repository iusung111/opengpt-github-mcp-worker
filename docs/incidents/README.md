# Incident Reports

Use this directory for operational incident reports, regression notes, and repeated failure prevention records.

## Goals

- keep root cause and remediation history inside the self repo
- make past failures readable from MCP with `repo_get_file`
- make new reports writable from MCP with `repo_update_file`
- reduce repeated investigation on the same failure pattern

## File naming

Use one file per incident with this pattern:

```text
<AREA>_INCIDENT_<YYYY-MM-DD>.md
```

Examples:

- `CHATGPT_CONNECTOR_INCIDENT_2026-03-22.md`
- `MCP_TOOL_EXPOSURE_INCIDENT_2026-03-24.md`
- `SELF_HOST_DEPLOY_INCIDENT_2026-03-24.md`

## Minimum report shape

Every report should include:

1. summary
2. symptoms
3. exact reproduction
4. root cause
5. remediation applied
6. verification
7. prevention / follow-up rules

## MCP usage

Use existing self-repo tools rather than a separate incident-specific tool:

- read a past report:
  - `repo_get_file(owner="iusung111", repo="opengpt-github-mcp-worker", path="docs/incidents/<file>.md")`
- inspect available reports:
  - `repo_tree_snapshot(owner="iusung111", repo="opengpt-github-mcp-worker", path="docs/incidents")`
- create or update a report on an agent branch:
  - `repo_update_file(owner="iusung111", repo="opengpt-github-mcp-worker", branch="agent/<job>", path="docs/incidents/<file>.md", ...)`

## Operator rule

When a new live, mirror, connector, routing, auth, or tool-surface failure is found:

1. read the relevant incident files first
2. fix the issue
3. update or create an incident report in this directory before closing the task
4. include exact verification commands and final state
