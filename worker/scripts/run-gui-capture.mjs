import fs from 'fs';
import path from 'path';

const artifactDir = path.join(process.cwd(), 'gui-capture-artifact');
fs.mkdirSync(artifactDir, { recursive: true });

const instructions = JSON.parse(Buffer.from(process.env.INSTRUCTIONS_B64 || '', 'base64').toString('utf8'));
const stepCount = Array.isArray(instructions.scenario?.steps) ? instructions.scenario.steps.length : 0;

const summary = {
	ok: true,
	mode: String(instructions.mode ?? 'unknown'),
	execution: {
		requested_app_url: instructions.app_url ?? null,
		resolved_app_url: instructions.app_url ?? process.env.LOCAL_HTML_URL ?? null,
		app_source: 'runner_scaffold',
		scenario_name: instructions.scenario?.name ?? null,
	},
	result: {
		overall_status: 'partial',
		requested_steps: stepCount,
	},
	steps: [],
	findings: [
		{
			severity: 'medium',
			summary: 'GUI capture runner scaffold active',
			rationale: 'This branch now emits summary and report artifacts for legacy/scenario requests. Full browser scenario execution is the next patch.',
		},
	],
	artifacts: {
		report: 'report.md',
		final_capture: null,
		screenshots: [],
	},
};

fs.writeFileSync(path.join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
fs.writeFileSync(
	path.join(artifactDir, 'report.md'),
	[
		'# GUI capture report',
		'',
		`- Status: partial`,
		`- Mode: ${summary.mode}`,
		`- Requested steps: ${stepCount}`,
		'',
		'This runner currently writes summary/report artifacts so the workflow can complete while the full browser scenario executor is being wired.',
	].join('\\n'),
	'utf8',
);
