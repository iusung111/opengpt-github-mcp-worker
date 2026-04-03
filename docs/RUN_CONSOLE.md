# Run Console

Use the run console when the operator needs a mission-level view instead of a flat list of jobs.

## Why It Exists

The queue still executes independent child jobs, but the console now groups related work as:

- `mission`: the aggregate record for one multiagent task
- `lane`: one explicit branch in the mission DAG
- `child job`: the existing queue execution unit behind a lane

This keeps the execution model compatible with existing `job_*` APIs while adding one control plane for orchestration, aggregate status, and bulk actions.

## UI Model

The console is a three-pane layout:

- left: mission dashboard plus standalone legacy jobs
- center: lane board for the selected mission
- right: selected child job detail, logs, approvals, and browser controls

The frontend lives under [public/gui/run-console](../public/gui/run-console/). The old [public/gui/run-console-app.js](../public/gui/run-console-app.js) is now a thin bootstrap only.

## Data Model

Mission state is stored separately from job state.

- `mission_id` is the parent orchestration key
- `lane_id` identifies each branch of work
- each lane can launch a child `job_id`
- `depends_on_lane_ids` encodes the DAG
- `attempt` tracks retries per lane

Relevant code:

- [worker/src/queue/missions/actions.ts](../worker/src/queue/missions/actions.ts)
- [worker/src/queue/missions/scheduler.ts](../worker/src/queue/missions/scheduler.ts)
- [worker/src/queue/missions/reconcile.ts](../worker/src/queue/missions/reconcile.ts)
- [worker/src/queue/missions/projections.ts](../worker/src/queue/missions/projections.ts)

## Lane Lifecycle

The scheduler drives lanes through these states:

- `queued`
- `runnable`
- `launched`
- `working`
- `blocked`
- `failed`
- `completed`
- `cancelled`
- `detached`

`detached` means a child job exists in the queue but is no longer attached to any current lane pointer. Reconcile keeps those job IDs visible instead of silently dropping them.

## Scheduler Rules

- mission v1 is single-repo only
- default parallelism is `3`
- hard cap is `4`
- duplicate spawn is prevented by `(mission_id, lane_id, attempt)` spawn tokens
- dependency gating is explicit: a lane becomes runnable only after all dependent lanes are completed
- mission reconcile runs on mission create, child job updates, approval resolution, retry, and periodic reconciliation

## Control Surface

Human and AI operators have two layers of control:

- child-level controls stay on the existing `job_control` and `permission_request_resolve` APIs
- mission-level controls handle aggregate pause, resume, cancel, retry, and YOLO toggles

Mission APIs:

- `GET /gui/api/missions`
- `GET /gui/api/missions/:id`
- `GET /gui/api/missions/:id/feed`
- `POST /gui/api/missions/:id/control`

Mission MCP tools:

- `mission_create`
- `mission_list`
- `mission_progress`
- `mission_event_feed`
- `mission_control`

## YOLO Mode

`YOLO mode` is mission-scoped and intentionally narrow.

- it can auto-approve only safe pending approvals
- it does not bypass deploy, release, rollback, reset, merge, or workflow-dispatch style gates
- unsafe approvals stay blocked and still require explicit resolution

The denylist is enforced in [worker/src/queue/missions/reconcile.ts](../worker/src/queue/missions/reconcile.ts).

## Polling And Performance

The console intentionally avoids per-card event fan-out.

- dashboard mission summaries poll every 15 seconds
- the selected mission detail polls every 5 seconds
- only the selected job detail and feeds load deep state
- legacy standalone jobs still render beside missions

This keeps the dashboard usable when lane count grows and limits repeated queue fan-out.

## Standalone Auth

The console can run in two modes:

- host-bridge mode inside the integrated environment
- standalone browser mode using Cloudflare Access login or a bearer token

Standalone auth and token flows live in:

- [public/gui/run-console/actions/auth-actions.mjs](../public/gui/run-console/actions/auth-actions.mjs)
- [public/gui/run-console/services/api-client.mjs](../public/gui/run-console/services/api-client.mjs)

## Operator Quick Paths

To inspect current work:

1. Open `/gui/`.
2. Select a mission from the left pane.
3. Use the center lane board to find blocked or failed lanes.
4. Open the child detail pane to resolve approvals or inspect feed items.

To operate by MCP instead of the GUI:

1. Call `mission_list`.
2. Call `mission_progress` for the selected mission.
3. Use `mission_control` for bulk actions.
4. Drop down to `job_progress`, `job_control`, and `permission_request_resolve` for child-level work.

## Related Docs

- [repo README](../README.md)
- [docs index](./README.md)
- [TOOL_SURFACE.md](./TOOL_SURFACE.md)
- [CHATGPT_MCP.md](./CHATGPT_MCP.md)
- [MCP_ACCESS.md](./MCP_ACCESS.md)
