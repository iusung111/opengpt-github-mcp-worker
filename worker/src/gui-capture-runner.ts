export type GuiCaptureRunMode = 'legacy_analysis' | 'html_scenario' | 'url_scenario';

export interface GuiCaptureArtifactSummary {
	ok: boolean;
	mode: GuiCaptureRunMode | string;
	execution?: Record<string, unknown>;
	result?: Record<string, unknown>;
	steps?: unknown[];
	findings?: unknown[];
	artifacts?: Record<string, unknown>;
	logs?: Record<string, unknown>;
	error?: string;
}
