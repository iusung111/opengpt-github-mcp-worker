import { describe, expect, it } from 'vitest';

import { buildGuiCaptureReport } from '../src/gui-capture-report';

describe('gui capture report', () => {
	it('renders a markdown report with findings', () => {
		const report = buildGuiCaptureReport({
			title: 'GUI capture report',
			mode: 'html_scenario',
			targetUrl: 'http://127.0.0.1:4173/index.html',
			overallStatus: 'fail',
			stepResults: [
				{
					index: 0,
					id: 'step-1',
					action: 'click',
					status: 'failed',
					error: 'selector not found',
					screenshot_after: 'screenshots/01-click-failure.png',
				},
			],
			findings: [
				{
					severity: 'high',
					step_index: 0,
					summary: 'Step failed: click',
					rationale: 'selector not found',
					screenshot_ref: 'screenshots/01-click-failure.png',
				},
			],
		});
		expect(report).toContain('Overall status: fail');
		expect(report).toContain('Step failed: click');
	});
});
