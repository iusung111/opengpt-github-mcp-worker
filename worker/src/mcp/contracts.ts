export interface ToolAnnotations extends Record<string, unknown> {
	readOnlyHint: boolean;
	openWorldHint: boolean;
	destructiveHint?: boolean;
}
