# Architecture Refactor Plan
_Target repository: `iusung111/opengpt-github-mcp-worker`_  
_Goal: preserve current features while improving call reliability, state consistency, and maintainability._

## 1. Objective

The current system already supports a broad surface area:

- Cloudflare Worker ingress and MCP endpoints
- Durable Object based queue and job orchestration
- GitHub Actions dispatch, webhook handling, and reconcile loops
- ChatGPT MCP, GUI, workflow, fullstack, and queue control surfaces

The refactor should **keep feature parity** while addressing structural risks:

- CI validation path and manual execution path are not consistently aligned
- workflow run linkage depends on delayed discovery
- recovery behavior is too redispatch-oriented
- too many tool groups are coupled into one MCP assembly path
- job transition rules are distributed across multiple modules

## 2. Current Structural Risks

### 2.1 Ingress and orchestration are tightly coupled
``worker/src/http.ts` currently mixes:

- HTTP routing
- auth and bootstrap behavior
- health and queue APIs
- MCP entry logic

This increases regression radius and makes route-level debugging harder.

### 2.2 MCP registry is overly centralized
`worker/src/mcp-tools.ts` registers nearly all feature groups in one place.  
That increases blast radius when one module breaks.

### 2.3 State transitions are distributed
Job state mutation logic is spread across:

- `queue.ts`
- `queue-requests.ts`
- `queue-reconcile.ts`
- `queue-workflow.ts`
- `queue-dispatch.ts`

This makes behavior harder to reason about and harder to test deterministically.

### 2.4 Dispatch-to-run linkage is weak
Workflow dispatch metadata is stored first, and the actual `workflow_run_id` is discovered later.  
That is workable, but fragile under delayed runs, repeated dispatches, or webhook timing gaps.

### 2.5 Recovery prefers replay over repair
Current stale/failure recovery tends to redispatch quickly instead of first repairing state or confirming external execution status.

## 3. Refactor Principles

### 3.1 Preserve external behavior
Do not remove or narrow current user-facing capabilities.

### 3.2 Refactor around failure isolation
Module boundaries should be drawn to reduce blast radius.

### 3.3 Centralize state transition policy
All job state changes should flow through one state machine boundary.

### 3.4 Treat GitHub timing as eventually consistent
Webhook arrival, workflow run visibility, and API freshness should be assumed to lag.

### 3.5 Prefer repair before replay
Redispatch should be a controlled fallback, not the default recovery path.

## 4. Target Architecture

### 4.1 Transport Layer
Responsibility:

- parse HTTP requests
- apply auth gates
- shape protocol responses
- expose bootstrap metadata

Suggested files:

- `worker/src/transport/http-router.ts`
- `worker/src/transport/mcp-entry.ts`
- `worker/src/transport/webhook-entry.ts`

### 4.2 Application Layer
Responsibility:

- coordinate use cases
- run commands and queries
- orchestrate services without owning domain rules

Suggested files:

- `worker/src/application/job-control-service.ts`
- `worker/src/application/workflow-dispatch-service.ts`
- `worker/src/application/reconcile-service.ts`
- `worker/src/application/mcp-session-service.ts`

### 4.3 Domain Layer
Responsibility:

- define job lifecycle rules
- validate transitions
- decide recovery and linkage policy

Suggested files:

- `worker/src/domain/job-state-machine.ts`
- `worker/src/domain/recovery-policy.ts`
- `worker/src/domain/run-linking-policy.ts`

### 4.4 Infrastructure Layer
Responsibility:

- Durable Object persistence
- GitHub API adapters
- auth adapters
- Cloudflare integration adapters

Suggested files:

- `worker/src/infra/storage/job-repository.ts`
- `worker/src/infra/storage/audit-repository.ts`
- `worker/src/infra/github/workflow-client.ts`
- `worker/src/infra/github/webhook-client.ts`
- `worker/src/infra/auth/chatgpt-oidc.ts`

### 4.5 Observability Layer
Responsibility:

- audit writing
- incident assembly
- run attention projection
- diagnostics

Suggested files:

- `worker/src/observability/audit-writer.ts`
- `worker/src/observability/run-attention.ts`
- `worker/src/observability/incident-assembler.ts`

## 5. Concrete Refactor Directions

### 5.1 Split `http.ts` into handlers plus routing shell
`http.ts` should become a thin router only.

Move behavior into dedicated handlers:

- `handlers/chatgpt-mcp-handler.ts`
- `handlers/direct-mcp-handler.ts`
- `handlers/webhook-handler.ts`
- `handlers/queue-api-handler.ts`
- `handlers/health-handler.ts`

### 5.2 Keep tool groups, but split registry assembly
Retain the current feature groups, but compose them through a smaller registry layer:

- `mcp/registry/core.ts`
- `mcp/registry/repo.ts`
- `mcp/registry/workflow.ts`
- `mcp/registry/queue.ts`
- `mcp/registry/gui.ts`
- `mcp/registry/fullstack.ts`

Final assembly should happen in a dedicated build module such as `mcp/build-server.ts`.

### 5.3 Introduce one state-machine boundary
No module should mutate `job.status` directly except the domain state machine.

Recommended pattern:

- `applyJobEvent(job, event)`
- `transitionJobState(job, command)`

Direct status writes from request handlers, reconcile logic, or workflow decision code should be removed.

### 5.4 Strengthen dispatch/run correlation
Instead of relying primarily on delayed “find latest workflow run” behavior, store and propagate a stronger correlation contract:

- `job_id`
- `dispatch_id`
- `correlation_id`
- `workflow_id`
- `ref`
- `inputs_hash`
- `dispatched_at`

Use correlation first, latest-run discovery only as fallback.

### 5.5 Reframe recovery policy
Recovery should be staged:
1. **Observe**   
wait for webhook, refresh run state, recheck delayed visibility

2. **Repair**   
fix missing linkage, stale metadata, or control-state divergence

3. **Replay**   
redispatch only when observation and repair cannot recover the job

### 5.6 Separate repositories behind Durable Object storage
Keep Durable Object storage, but isolate persistence responsibilities:

- `JobRepository`
- `AuditRepository`
- `DeliveryRepository`
- `WorkspaceRepository`

This allows clearer indexing, retention, and testing boundaries.

### 5.7 Separate control intent from execution result
Pause, cancel, resume, and retry should be represented as two-step flows:

- intent recorded
- effect applied

That distinction reduces ambiguity during races and makes audit trails clearer.

### 5.8 Unify validation paths
Manual execution success must not bypass the same validation contract used by CI.

Required common checks:

- typecheck
- tests
- MCP registry assembly validation
- route smoke checks
- queue state transition tests

If CI is red, release-like execution should not be treated as structurally healthy.

## 6. Suggested Directory Shape

```text
worker/src/
  transport/
  handlers/
  application/
  domain/
  infra/
  observability/
  mcp/
  gui/
  shared/
```

Possible migration mapping:

- `http.ts` → transport/http-router.ts`
- queue orchestration logic → `application/`
- workflow decision logic → `domain/`
- GitHub and storage adapters → `infra/`
- audit and incident helpers → `observability/`

## 7. Testing Strategy

### 7.1 Unit tests
Focus on:

- transition rules
- stale and timeout decisions
- recovery policy
- run-linking logic

### 7.2 Integration tests
Focus on:

- queue API => job update => reconcile
- webhook => job/run linkage
- dispatch => run discovery => completion handling

### 7.3 Contract tests
Focus on:

- MCP registry output
- workflow dispatch payload contract
- webhook payload parsing
- ChatGPT MCP bootstrap/auth response behavior

### 7.4 Regression scenarios to lock down
At minimum, keep fixed tests for:

- dispatch succeeds but run linkage is delayed
- webhook missing, reconcile recovers
- workflow cancelled or timed out
- manual retry and reconcile interacting
- review timeout
- success without immediate PR linkage

## 8. Recommended Migration Phases

### Phase 1. Stabilize the baseline
- fix current CI red state
- add missing validation gates
- lock key transition behavior with tests

### Phase 2. Centralize state transitions
- route all job status changes through one domain boundary

### Phase 3. Rework dispatch/run linkage
- introduce correlation id based linkage
- reduce dependence on “latest run” search

### Phase 4. Split MCP registry assembly
- keep features intact
- reduce coupling and blast radius

### Phase 5. Isolate storage and observability concerns
- introduce repositories
- standardize incident and control-state reporting

## 9. Expected Outcome

This refactor should preserve current features while delivering:

- more reliable call paths
- clearer job lifecycle behavior
- lower regression radius
- safer recovery behavior
- stronger dispatch/run traceability
- more testable module boundaries

## 10. Decision Summary

The system should not be rebuilt around new features first.  
The highest-value structural changes are:

1. centralize job transition rules
2. harden dispatch-to-run correlation
3. unify validation across CI and manual execution paths

Those three changes will improve reliability without reducing the current tool surface.
