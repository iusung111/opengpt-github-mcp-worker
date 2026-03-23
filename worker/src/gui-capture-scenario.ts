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

export function sanitizeStepName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'step';
}

export function stepScreenshotName(index: number, name: string, phase: 'before' | 'after' | 'failure'): string {
	const prefix = String(index + 1).padStart(2, '0');
	return `screenshots/${prefix}-${sanitizeStepName(name)}-${phase}.png`;
}
