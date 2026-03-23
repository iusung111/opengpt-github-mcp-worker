import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { ToolAnnotations } from './mcp-overview-tools';
import { AppEnv } from './types';
import { fail, toolText } from './utils';

export function registerGuiTools(server: McpServer, _env: AppEnv, writeAnnotations: ToolAnnotations): void {
  server.registerTool(
    'gui_capture_run',
    {
      description: 'GUI capture tool is temporarily unavailable while the scenario refactor is being repaired.',
      inputSchema: {
        file_name: z.string().optional(),
        file_text: z.string().optional(),
        app_url: z.string().optional(),
        ref: z.string().optional(),
        analysis: z.any().optional(),
        scenario: z.any().optional(),
        report: z.any().optional(),
        include_image_base64: z.boolean().default(false),
        wait_timeout_seconds: z.number().int().positive().max(240).default(120),
      },
      annotations: writeAnnotations,
    },
    async () => toolText(fail('gui_capture_run_temporarily_unavailable', 'gui_capture_run is temporarily unavailable during refactor repair', writeAnnotations)),
  );
}
