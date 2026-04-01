# Architecture Refactor Execution Plan
_Target repository: `iusung111/opengpt-github-mcp-worker`_  
_Purpose: translate the structural refactor plan into a safe, phased, function-preserving patch sequence._

## 1. Execution goals

This plan assumes the following non-negotiables:

- no intentional feature removal
- no big-bang rewrite
- each phase must leave the repo in a runnable or at least validatable state
- state transition behavior must become more explicit, not more implicit
- dispatch/run traceability must improve before further automation increases

## 2. Patch sequence overview

### Phase 0. Baseline stabilization
* Objective:* return the repo to a known validation baseline before moving any major structural pieces.

* Scope:
- fix current type/symbol drift in cloudflare-ci
- remove or reconcile broken import paths
- establish a minimal green baseline for typecheck and tests

* Target files, likely first:
- `worker/src/utils.ts`
- `worker/src/http.ts`
- `worker/src/gui-api.ts`
- `worker/src/mcp-fullstack-tools.ts`
- `.github/workflows/cloudflare-ci.yml`

* Definition of done:
- cloudflare-ci is green
- no missing exports or undefined symbols in primary execution paths
- manual exec and CI no longer disagree on basic buildability

### Phase 1. Test and validation canoricalization
* Objective:* make structural work safe by locking today’s behavior in tests.

* Scope:
- add tests for current job state transitions
- add tests for stale reconcile and review timeout
- add tests for dispatch -> run discovery behavior
- add tests for ChatGPT MCP bootstrap and auth boundaries

* Recommended test areas:
- `worker/test/queue-state.spec.ts`
- `worker/test/queue-reconcile.spec.ts`
- `worker/test/queue-workflow.spec.ts`
- `worker/test/http-chatgpt-mcp.spec.ts`

* Definition of done:
- key current behaviors are explicitly covered
- regression signals appear before structural breakage

### Phase 2. State machine extraction
 * Objective:* centralize judgment about jub state changes without changing external behavior yet.

* Scope:
- introduce `domain/job-state-machine.ts`
- define events or commands that cover today’s transitions
- route existing `transitionJob`-style logic through the new boundary
- keep existing status values to avoid breaking consumers

* Implementation notes:
- start by moving policy, not storage
- keep pasive helpers as compatibility wrappers during migration
- avoid renaming top-level status types in this phase

* Definition of done:
- queue-requests, queue-reconcile, and queue-workflow no longer own independent transition rules
- state changes pass through one domain boundary

### Phase 3. Dispatch/run correlation hardening
* Objective:* make workflow run linkage more deterministic.

* Scope:
- introduce a correlation endity for dispatch records
- push correlation identifiers into workflow inputs where possible
- record immutable dispatch envelope metadata
- rework run discovery to use correlation-first, latest-run search second

* Primary files;
- `worker/src/queue-dispatch.ts`
- `worker/src/queue-reconcile.ts`
- `worker/src/queue-github.ts`
- `worker/src/job-manifest.ts`

* Definition of done:
- a job and its dispatch attempt can be unambiguously traced
- reconcile no longer depends primarily on "latest run near timestamp" heuristics

### Phase 4. Recovery policy rebalancing
* Objective:* slow down automatic redispatch and prefer repair.

* Scope:
- codify recovery stages: observe, repair, replay
- add explicit policy for which failures may be retried
- separate auto-recovery from manual retry semantics
- make stale reasons and replay reasons more structured

* Target files:
- `worker/src/domain/recovery-policy.ts`
- `worker/src/queue-reconcile.ts`
- `worker/src/queue-requests.ts`
- `worker/src/queue-dispatch.ts`

* Definition of done:
- redispatch is one explicit step in a policy, not the default response to every error
- audit trails clearly show whether the system observed, repaired, or replayed

### Phase 5. Transport/handler decoupling
 * Objective:* split ingress shape from application behavior.

* Scope:
- turn `http.ts` into a thin router or facade
- extract dedicated handlers for webhook, queue API, health, direct MCP, and ChatGPT MCP
- move auth-and-bootstrap specific logic out of routing code organization

* Target files/modules:
- `worker/src/transport/http-router.ts`
- `worker/src/handlers/chatgpt-mcp-handler.ts`
- `worker/src/handlers/direct-mcp-handler.ts`
- `worker/src/handlers/webhook-handler.ts`
- `worker/src/handlers/queue-api-handler.ts`
- `worker/src/handlers/health-handler.ts`

* Definition of done:
- routing and use-case logic are no longer interleaved
- endpoint behavior is testable without full queue or MCP bootstrap

### Phase 6. Storage repository extraction
 * Objective:* keep Durable Object persistence, but separate persistence concerns.

* Scope:
- introduce repositories for jobs, audits, deliveries, and workspaces
- move index and retention logic behind these abnstractions
- keep DO as the host, not the business-logic center

* Primary modules:
- `worker/src/infra/storage/job-repository.ts`
- `worker/src/infra/storage/audit-repository.ts`
- `worker/src/infra/storage/delivery-repository.ts`
- `worker/src/infra/storage/workspace-repository.ts`
- `worker/src/queue.ts` as the composition host only

* Definition of done:
- queue.durable object no longer owns persistence details directly
- storage and business logic can be tested separately

### Phase 7. MCP registry reorganization
 * Objective:* keep tool surface compatible while reducing assembly coupling.

* Scope:
- keep existing tool groups and names unchanged
- introduce registry assembly modules
- setup optional feature-health or group-level guards where helpful

* Target modules:
- `worker/src/mcp/build-server.ts`
- `worker/src/mcp/registry/core.ts`
- `worker/src/mcp/registry/repo.ts`
- `worker/src/mcp/registry/workflow.ts`
- `worker/src/mcp/registry/queue.ts`
- `worker/src/mcp/registry/gui.ts`
- `worker/src/mcp/registry/fullstack.ts`

* Definition of done:
- MCP server build flow is modular, not monolithic
- one tool group failure is easier to isolate and debug

### Phase 8. Observability normalization
 * Objective:* make investigation and operational decisions more direct.

* Scope:
- normalize audit event shapes
- make control state, attention status, and recovery stage explicit
- standardize incident/bundle content sources

* Definition of done:
- operators can tell why a job is waiting, interrupted, or retried without reading multiple modules

## 3. Cross-phase guardrails

### 3.1 Do not combine phases in a single patch
Keep each phase reviewable and reversible.

### 3.2 Prefer introducing compatibility wrappers
especially during Phases 2 5, where callers still expect current module shapes.

### 3.3 Lock behavior before renaming anything
Major renames should follow behavior-locked tests, not precede them.

### 3.4 Turn off or limit auto-improve for deep structural patches
During Phases 2-6, auto-redispatch and retry behavior should be either tightly limited or explicitly monitored.

## 3.5 Keep external contracts stable as long as possible
This includes:
- MCP tool names
- queue API payload shapes
- health endpoint core fields
- existing workflow entry behavior

## 4. Recommended next patch sery

### Patch 1. Baseline ci fix
- resolve missing utils export/usage drift
- restore green validation

### Patch 2. Transition test lock
- add queue/reconcile/workflow regression tests

### Patch 3. State machine introduction
- introduce new domain boundary
- route legacy helpers through it

### Patch 4. Correlation hardening
- add dispatch envelope
- remake run discovery order

### Patch 5. Recovery policy cleanup
- rebalance redispatch and repair behavior

### Patch 6. Transport/handler extraction
- split `http.ts` without changing external routes

### Patch 7. Storage repository extraction
- isolate persistence and indexing concerns

### Patch 8. MCP registry reorganization
- modularize assembly
- keep tool surface compatible

## 5. Acceptance checklist for each patch

- CI passes
- existing tests pass
- new tests cover the behavior introduced
- no MCP tool name regression
- no queue API shape regression
- no basic health endpoint regression
- audit and run progress remain inspectable

## 6. Decision rule

If a patch series forces an external contract change, stop and split the work.  
The refactor should proceed by internal structural improvement, not by moving breakage into callers or operators.
