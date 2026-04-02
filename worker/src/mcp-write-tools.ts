import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppEnv } from './contracts';
import type { ToolAnnotations } from './mcp/contracts';
import { registerWriteBatchPrTools } from './mcp/write/batch-pr';
import { registerWriteBranchUploadTools } from './mcp/write/branch-upload';

export function registerWriteTools(server: McpServer, env: AppEnv, writeAnnotations: ToolAnnotations): void {
	registerWriteBranchUploadTools(server, env, writeAnnotations);
	registerWriteBatchPrTools(server, env, writeAnnotations);
}
