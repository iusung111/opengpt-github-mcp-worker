import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppEnv } from './contracts';
import type { ToolAnnotations } from './mcp/contracts';
import { registerFullstackApiTools } from './mcp/fullstack/api';
import { registerFullstackBrowserTools } from './mcp/fullstack/browser';
import { registerFullstackDatabaseTools } from './mcp/fullstack/database';
import { registerFullstackDesktopTools } from './mcp/fullstack/desktop';
import { registerFullstackObservabilityTools } from './mcp/fullstack/observability';
import { registerFullstackPreviewTools } from './mcp/fullstack/preview';
import { registerFullstackReleaseTools } from './mcp/fullstack/release';
import { registerFullstackVerificationTools } from './mcp/fullstack/verification';

export function registerFullstackTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	registerFullstackVerificationTools(server, env, readAnnotations, writeAnnotations);
	registerFullstackPreviewTools(server, env, readAnnotations, writeAnnotations);
	registerFullstackBrowserTools(server, env, readAnnotations, writeAnnotations);
	registerFullstackDesktopTools(server, env, readAnnotations, writeAnnotations);
	registerFullstackApiTools(server, env, readAnnotations, writeAnnotations);
	registerFullstackDatabaseTools(server, env, readAnnotations, writeAnnotations);
	registerFullstackObservabilityTools(server, env, readAnnotations, writeAnnotations);
	registerFullstackReleaseTools(server, env, readAnnotations, writeAnnotations);
}
