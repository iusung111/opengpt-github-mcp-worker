export interface GuiCaptureArtifactSummary {
	ok: boolean;
	mode: string;
	execution?: Record<string, unknown>;
	result?: Record<string, unknown>;
	steps?: unknown[];
	findings?: unknown[];
	artifacts?: Record<string, unknown>;
	logs?: Record<string, unknown>;
	error?: string;
}
