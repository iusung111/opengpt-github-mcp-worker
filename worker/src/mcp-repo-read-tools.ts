import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppEnv } from './contracts';
import type { ToolAnnotations } from './mcp/contracts';
import { registerRepoReadFileTools } from './mcp/repo-read/files';
import { registerRepoReadNavigationTools } from './mcp/repo-read/navigation';
import { matchesTreePathScope } from './mcp/repo-read/shared';
import { registerRepoReadTreeSearchTools } from './mcp/repo-read/tree-search';

export { matchesTreePathScope };

export function registerRepoReadTools(server: McpServer, env: AppEnv, readAnnotations: ToolAnnotations): void {
	registerRepoReadNavigationTools(server, env, readAnnotations);
	registerRepoReadFileTools(server, env, readAnnotations);
	registerRepoReadTreeSearchTools(server, env, readAnnotations);
}
