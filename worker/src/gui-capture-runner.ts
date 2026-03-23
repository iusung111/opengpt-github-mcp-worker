export type GuiCaptureRunMode = 'legacy_analysis' | 'html_scenario' | 'url_scenario';

// Note: this module currently defines the shape of artifact summaries.
// The workflow-run executor will be extended to produce these fields

// for full scenario-validation evidence in follow-up patches.

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
