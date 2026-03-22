import { describe, expect, it } from 'vitest';
import { buildPermissionBundleMessage, resolvePermissionBundle } from '../src/tool-catalog';

describe('tool catalog permission bundles', () => {
	it('resolves preset bundles into groups and tools', () => {
		const bundle = resolvePermissionBundle({
			preset: 'implementation_with_workflow',
		});
		expect(bundle.capabilities).toEqual(['queue', 'read', 'workflow', 'workspace', 'write']);
		expect(bundle.groups.some((group) => group.id === 'repo_write')).toBe(true);
		expect(bundle.tools).toContain('workflow_dispatch');
		expect(bundle.tools).toContain('gui_capture_run');
		expect(bundle.tools).toContain('repo_create_branch');
	});

	it('builds a user-facing approval request for batch approval', () => {
		const payload = buildPermissionBundleMessage({
			repos: ['iusung111/OpenGPT'],
			reason: 'need one approval for branch, PR, workflow rerun, and queue updates',
			preset: 'implementation_with_workflow',
		});
		expect(payload.approved_tools).toContain('workflow_dispatch');
		expect(payload.approved_tools).toContain('job_append_note');
		expect(payload.approval_request).toContain('Approve one MCP permission bundle');
		expect(payload.preset).toMatchObject({
			id: 'implementation_with_workflow',
		});
	});

	it('includes reviewer context tools in the review follow-up preset', () => {
		const bundle = resolvePermissionBundle({
			preset: 'review_followup',
		});
		expect(bundle.capabilities).toEqual(['queue', 'read', 'review', 'write']);
		expect(bundle.groups.some((group) => group.id === 'collaboration')).toBe(true);
		expect(bundle.tools).toContain('review_prepare_context');
		expect(bundle.tools).toContain('job_submit_review');
	});
});
