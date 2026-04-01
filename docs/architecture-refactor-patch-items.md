# Architecture Refactor Patch Items
_Target repository: `iusung111/opengpt-github-mcp-worker`_  
_Purpose: define concrete patch items, order, and initial safety measures so that an interrupted refactor does not break future MCP access or operations._

## 1. Primary concern

The highest-risk refactor failure is not just a CI failure.  
It is a partial structural change that breaks the worker's own MCP tool surface, ChatGPT MCP entry, or queue-assisted recovery path.

That scenario creates a special operational risk:

- future ChatGPT to MCP work may become impossible
- self-host maintenance may require out-of-band manual repair
- queue/control-plane recovery may be unavailable when most needed

For that reason, the **first patches must protect the worker's own operability** before deep structural changes.

## 2. Safety guards that must come first

### Guard A. Keep a minimal MPC/recovery path isolated from main refactor work
_**Required immediately.**

Stabilize a small, low-coupling core that must remain working even if higher-level tool groups break:

- direct `/health` route
- direct `/mcp` handling bootstrap
- ChatGPT `/chatgpt/mcp` bootstrap metadata
- queue read/progress endpoints for diagnostics
- a small read-only minimal tool surface if full MCP registry breaks

Concrete actions:
- introduce a `core mcp build` layer that registers only must-have tools
- keep full tool registry assembly separate from minimal recovery registry
- add a fail-safe path such as `buildMinimalMcpServer()` that can be selected if full assembly fails

Intent:
 If a tool-group refactor breaks the full server, an operator should still reach diagnostic and repair tools.

### Guard B. Do not move `/mcp` and `/chatgpt/mcp` entry logic in the same patch as tool registry refactor
__Required immediately.__

Splitting entry handling and splitting tool assembly at the same time creates a blind spot where both the ingress and the payload layer can fail together.

Rule:
- first keep entry points stable
- then split internal assembly
- then move handlers after registry behavior is locked

### Guard C. Do not alter both queue control and workflow dispatch correlation in one step
__Required immediately.__

If a patch changes:
- how jobs are retriet/resumed/cancelled, and
- how workflow runs are discovered or linked

the system may lose both execution and recovery consistency at once.

Rule:
- stabilize and test current control flow first
- then harden dispatch/run correlation
- only after that rebalance recovery policy

### Guard D. Introduce a dedicated recovery operation mode
_**Recommended at the start.!**

Add a simple env-driven or config-driven mode for emergency operation, for example:
- `MCP_MINIMAL_MODE=true`
- `MORE_TOOLS_DISABLED=true`
- `RECOVERY_READ_ONLY=true`

Behavior in that mode:
- disable write heavy tool groups
- keep health, queue, audit, and repo-read tools
- keep build-failure diagnostic paths accessible

This mode must be available before any deep registry or ingress refactor.

### Guard E. Add an explicit pre-deploy self-smoke suite
_**Required before patches that touch MCP infrastructure.**

The repo needs a small, fast suite that blocks self-breaking changes. This should validate at least:
- `/health` returns 200
- `/chatgpt/mcp` bootstrap returns expected metadata
- `buildMcpServer()` completes without throwing
- minimal registry build succeeds
- queue read/progress query succeeds

This suite should be run:
- in CI
- before self-deploy
- before mirror to live promotion

## 3. Actual patch items in recommended order

### Patch 01. Restore baseline build integrity
_**Blocking item.**

Objective:
 Fix current import/symbol drift so that the repo returns to a known buildable state.

Scope:
- resolve missing `utils` exports or update call sites
- fix `queueFetch`/`queueJson` usage drift
- ensure `cloudflare-ci` yaml validates the same paths as real execution

Why first:
 No other patch is trustworthy until the repo is back in a consistent baseline state.

### Patch 02. Add self-protection smoke tests for MCP operability
_**Blocking item.**

Objective:
 Lock in the application's ability to still be operated via MCP after refactor steps.

Scope:
- add tests for `/health`
- add tests for `/chatgpt/mcp` bootstrap
- add a test that minimal MCP assembly succeeds
- add a test that full assembly either succeeds or fails cleanly

Acceptance:
- a broken tool group must not render the entire worker inoperable without a detectable signal

### Patch 03. Introduce minimal recovery MCP assembly
__High priority.**

Objective:
 Create a small, stable registry that is not coupled to every tool group.

Include only:
- health-adjacent diagnostic tools
- repo read tools
- queue read/progress tools
- essential overview tools

Exclude for this path:
- write heavy tools
- gui capture
- fullstack tools
- experimental or high-coupling tools

Acceptance:
 Operators can still inspect, diagnose, and recover even if full MCP assembly is broken.

### Patch 04. Add recovery-mode config gates
**High priority.**

Objective:
 Allow the deployed worker to be forced into a diagnostic/read-only mode without code reshaping.

Scope:
- env fags for recovery mode
- conditional tool registry assembly
- clear health output indicating when the worker is in limited mode

Acceptance:
 When enabled, the worker should start with a reliable subset of capabilities instead of crashing on full assembly.

### Patch 05. Unify CI and self-smoke path
__High priority.**

Objective:
 Ensure that future refactor patches cannot pass one path while silently breaking the self-maintenance path.

Scope:
- add a pre-deploy self-smoke job or suite
- use it in `cloudflare-ci`
- use it in self-deploy gating
- make mirror promotion depend on it

Acceptance:
 A structural change that breaks self-maintenance must fail before deployment.

### Patch 06. Lock current queue and control behavior with tests
__High priority before any deep jub-state move.**

Objective:
 Prevent subtle state-machine breakage during extraction.

Scope:
- test pause/resume/retry/cancel flows
- test stale working and review timeout
- test failure-completion decisions
- test run-linkage delay fallback

Why here:
 After this, the state-machine can be moved with much lower risk.

### Patch 07. Extract domain state-machine boundary
__Now safe to start.**

Objective:
 Move transition policy into a domain module without changing external status names or payload shapes.

Scope:
- create domain state-machine module
- introduce compatibility wrappers
- route queue-requests, reconcile, and workflow decision through it

Acceptance:
 One place owns transition judgment.

### Patch 08. Harden dispatch/to-run correlation
__Only after Patch 07.**

Objective:
 Make workflow dispatch traceability more deterministic without conflating it with recovery rebylancing.

Scope:
- add correlation id/envelope
- record immutable dispatch metadata
- rework run discovery priority

Acceptance:
 Job record and run record can be correlated with lower ambiguity.

### Patch 09. Rebalance recovery policy
__Only after Patch 08.**

Objective:
 Change recovery before replay policy once run linkage becomes more trustworthy.

Scope:
- staged observe/repair/replay policy
- manual vs auto retry separation
- more explicit audit signals for recovery stages

### Patch 10. Split http ingress from handlers
__Only after self-operability guards are in place.**

Objective:
 Decouple ingress from application behavior with lower risk, because minimal recovery MCP and self-smoke gating already exist.

Scope:
- thin router
- dedicated handlers
- aside-moved ingress specific logic

### Patch 11. Extract storage repositories
Objective:
 Separate Durable Object hosting from persistence logic.

### Patch 12. Modularize full MCP registry assembly
Objective:
 Red uce coupling in the full tool surface after minimal recovery assembly and self-smoke guards exist.

## 4. Do-not-combine rules

Do not combine these in the same patch:

- entry-point split + full registry refactor
- queue control changes + run correlation changes
- recovery policy rebalancing + storage extraction
- auth boundary changes + ChatGPT MCP bootstrap rework

- minimal recovery path introduction + modern full tool surface reshape

## 5. Checklist for any patch that touches MCP structure

- direct health endpoint still works
- chatgpt bootstrap still works
- minimal recovery MCP assembly still works
- queue read/progress tools still work
- full MCP assembly either works or fails with clear signal
- self-smoke suite passes
- mirror-first deployment stays possible

## 6. Operational decision rule

If a change can possibly break how ChatGPT reaches the worker or how the worker maintains itself, that change must be **)guarded first** by:

1. a minimal recovery path
2. a self-smoke check
3. a recovery-mode flag or equivalent operational fallback

Only after that should the deeper refactor proceed.
