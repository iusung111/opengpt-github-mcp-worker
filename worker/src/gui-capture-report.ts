export interface GuiCaptureFinding {
	severity: 'low' | 'medium' | 'high' | 'critical';
	step_index?: number;
	summary: string;
	rationale: string;
	screenshot_ref?: string | null;
}

export interface GuiCaptureStepResult {
	index: number;
	id: string;
	action: string;
	status: 'passed' | 'failed' | 'skipped';
	message?: string;
	screenshot_before?: string | null;
	screenshot_after?: string | null;
	error?: string | null;
}

export function buildGuiCaptureReport(input: {
	title: string;
	mode: string;
	targetUrl: string | null;
	overallStatus: 'pass' | 'fail' | 'partial';
	stepResults: GuiCaptureStepResult[];
	findings: GuiCaptureFinding[];
	consoleErrors?: string[];
	networkErrors?: string[];
}): string {
	const lines: string[] = [];
	lines.push(`# ${input.title}`);
	lines.push('');
	lines.push(`- Mode: ${input.mode}`);
	lines.push(`- Target URL: ${input.targetUrl ?? 'n/a'}`);
	lines.push(`- Overall status: ${input.overallStatus}`);
	lines.push(`- Steps: ${input.stepResults.length}`);
	lines.push('');

	lines.push('## Step results');
	lines.push('');
	for (const step of input.stepResults) {
		lines.push(`### ${step.index + 1}. ${step.action} (${step.status})`);
		if (step.message) lines.push(`- Message: ${step.message}`);
		if (step.error) lines.push(`- Error: ${step.error}`);
		if (step.screenshot_before) lines.push(`- Screenshot before: ${step.screenshot_before}`);
		if (step.screenshot_after) lines.push(`- Screenshot after: ${step.screenshot_after}`);
		lines.push('');
	}

	lines.push('## Findings');
	lines.push('');
	if (input.findings.length === 0) {
		lines.push('- No findings');
		lines.push('');
	} else {
		for (const finding of input.findings) {
			lines.push(`- [${finding.severity}] ${finding.summary}`);
			lines.push(`  - Rationale: ${finding.rationale}`);
			if (typeof finding.step_index === 'number') lines.push(`  - Step: ${finding.step_index + 1}`);
			if (finding.screenshot_ref) lines.push(`  - Screenshot: ${finding.screenshot_ref}`);
		}
		lines.push('');
	}

	if ((input.consoleErrors?.length ?? 0) > 0) {
		lines.push('## Console errors');
		lines.push('');
		for (const entry of input.consoleErrors ?? []) lines.push(`- ${entry}`);
		lines.push('');
	}

	if ((input.networkErrors?.length ?? 0) > 0) {
		lines.push('## Network errors');
		lines.push('');
		for (const entry of input.networkErrors ?? []) lines.push(`- ${entry}`);
		lines.push('');
	}

	return lines.join('\n');
}
