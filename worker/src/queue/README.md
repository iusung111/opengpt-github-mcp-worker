# Queue Map

Use this folder to find queue behavior by responsibility instead of reading the Durable Object monolith.

- `actions/`: queue action routing and per-action handlers.
- `projections/`: run status, blocking state, event feed, and progress snapshot builders.
- `browser-control-router.ts`: browser companion HTTP surface for the queue Durable Object.

Public entrypoints:

- `../queue.ts`: Durable Object composition root
- `../queue-requests.ts`: action router export
- `../queue-projections.ts`: projection export
