import { describe, expect, it } from 'vitest';

import { sanitizeStepName, stepScreenshotName } from '../src/gui-capture-scenario';

describe('gui capture scenario helpers', () => {
	it('sanitizes step names', () => {
		expect(sanitizeStepName('Click Login Button')).toBe('click-login-button');
	});

	it('builds screenshot names', () => {
		expect(stepScreenshotName(1, 'Click Login Button', 'after')).toBe('screenshots/02-click-login-button-after.png');
	});
});
