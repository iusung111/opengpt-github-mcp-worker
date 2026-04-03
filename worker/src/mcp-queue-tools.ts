import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppEnv } from './contracts';
import type { ToolAnnotations } from './mcp/contracts';
import { registerQueueJobTools } from './mcp/queue/jobs';
import { registerMissionQueueTools } from './mcp/queue/missions';
import { registerQueueProgressTools } from './mcp/queue/progress';
import { registerQueueReviewTools } from './mcp/queue/reviews';

export function registerQueueTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	registerQueueJobTools(server, env, readAnnotations, writeAnnotations);
	registerMissionQueueTools(server, env, readAnnotations, writeAnnotations);
	registerQueueProgressTools(server, env, readAnnotations, writeAnnotations);
	registerQueueReviewTools(server, env, writeAnnotations);
}


