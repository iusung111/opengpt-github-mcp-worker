import { describe, expect, it } from 'vitest';
import { buildPermissionBundleMessage, resolvePermissionBundle } from '../src/tool-catalog';

describe('tool catalog permission bundles', () => {
	it('resolves preset bundles into groups and tools', () => {
		const bundle = resolvePermissionBundle({
			preset: 'implementation_with_workflow',
		});
		expect(bundle.capabilities).toEqual(['queue', 'read', 'workflow', 'workspace', 'write']);
		expect(bundle.groups.some((group) => group.id === 'repo_write')).toBe(true);
		expect(bundle.tools).toContain('run_console_open');
		expect(bundle.tools).toContain('workflow_dispatch');
		expect(bundle.tools).toContain('gui_capture_run');
		expect(bundle.tools).toContain('repo_create_branch');
		expect(bundle.tools).toContain('repo_create_file');
		expect(bundle.tools).toContain('repo_upsert_file');
		expect(bundle.tools).toContain('repo_upload_start');
		expect(bundle.tools).toContain('repo_upload_commit');
		expect(bundle.tools).toContain('repo_batch_write');
		expect(bundle.tools).toContain('repo_apply_patchset');
		expect(bundle.tools).toContain('verify_run');
		expect(bundle.tools).toContain('preview_env_create');
		expect(bundle.tools).toContain('browser_action_batch');
		expect(bundle.tools).toContain('desktop_build_run');
		expect(bundle.tools).toContain('api_contract_list');
		expect(bundle.tools).toContain('db_schema_inspect');
		expect(bundle.tools).toContain('db_reset_prepare');
		expect(bundle.tools).toContain('runtime_log_query');
		expect(bundle.tools).toContain('deploy_promote');
		expect(bundle.tools).toContain('job_event_feed');
		expect(bundle.tools).toContain('job_control');
		expect(bundle.tools).toContain('permission_request_resolve');
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
		expect(bundle.tools).toContain('job_control');
	});

	it('resolves the desktop fullstack preset into the extended workflow surface', () => {
		const bundle = resolvePermissionBundle({
			preset: 'desktop_fullstack',
		});
		expect(bundle.groups.some((group) => group.id === 'verification')).toBe(true);
		expect(bundle.groups.some((group) => group.id === 'release')).toBe(true);
		expect(bundle.tools).toContain('release_verify');
		expect(bundle.tools).toContain('browser_collect_diagnostics');
	});
});
