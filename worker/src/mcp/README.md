# MCP Map

Use this folder to find MCP tool registration code quickly.

- `contracts.ts`: shared MCP annotation contract.
- `repo-read/`: navigation, file-read, tree, and search registration.
- `write/`: branch, file write, upload, batch write, PR, and comment registration.

Public entrypoints:

- `../mcp-tools.ts`: server composition root
- `../mcp-repo-read-tools.ts`: repo-read registrar
- `../mcp-write-tools.ts`: write registrar
- `../mcp-fullstack-tools.ts`: fullstack registrar
- `queue/`: queue tool registrars split by jobs, progress, and reviews
- `fullstack/`: fullstack tool registrars split by verification, preview, browser, desktop, api, database, observability, and release
