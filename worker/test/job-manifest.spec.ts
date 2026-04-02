import { describe, expect, it } from 'vitest';
import {
	createEmptyWorkerManifest,
	getManifestDispatchRequest,
	getManifestWorkflowRun,
	mergeWorkerManifest,
	normalizeWorkerManifest,
} from '../src/job-manifest';

describe('job manifest helpers', () => {
	it('creates an empty typed worker manifest', () => {
		expect(createEmptyWorkerManifest()).toMatchObject({
			schema_version: 1,
			execution: {},
			verification: {},
			preview: {},
			browser: {},
			desktop: {},
			runtime: {},
		});
	});

	it('normalizes legacy top-level dispatch and workflow state into execution', () => {
		const manifest = normalizeWorkerManifest({
			dispatch_request: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'agent-run.yml',
				ref: 'main',
				inputs: { job_id: 'job-1' },
				dispatched_at: '2026-03-21T00:00:00.000Z',
			},
			last_workflow_run: {
				status: 'completed',
				conclusion: 'success',
			},
		});

		expect(getManifestDispatchRequest(manifest)).toMatchObject({
			workflow_id: 'agent-run.yml',
		});
		expect(getManifestWorkflowRun(manifest)).toMatchObject({
			status: 'completed',
			conclusion: 'success',
		});
		expect(manifest.execution).toMatchObject({
			dispatch_request: {
				workflow_id: 'agent-run.yml',
			},
			last_workflow_run: {
				status: 'completed',
			},
		});
	});

	it('merges typed manifest sections without losing existing execution data', () => {
		const merged = mergeWorkerManifest(
			{
				execution: {
					dispatch_request: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						workflow_id: 'agent-run.yml',
						ref: 'main',
						inputs: {},
						dispatched_at: '2026-03-21T00:00:00.000Z',
					},
				},
			},
			{
				verification: {
					status: 'running',
					profile: 'desktop-smoke',
				},
			},
		);

		expect(getManifestDispatchRequest(merged)).toMatchObject({
			workflow_id: 'agent-run.yml',
		});
		expect(merged.verification).toMatchObject({
			status: 'running',
			profile: 'desktop-smoke',
		});
	});

	it('normalizes chatgpt web session context and ignores invalid provider patches during merge', () => {
		const normalized = normalizeWorkerManifest({
			browser: {
				session_context: {
					provider: 'chatgpt_web',
					session_url: ' https://chatgpt.com/c/example ',
					canonical_conversation_url: '',
					conversation_id: ' convo-1 ',
					auth_state: 'authenticated',
					approval_state: 'granted',
					followup_state: 'ready',
					can_send_followup: true,
				},
			},
		});

		expect(normalized.browser?.session_context).toMatchObject({
			provider: 'chatgpt_web',
			session_url: 'https://chatgpt.com/c/example',
			canonical_conversation_url: null,
			conversation_id: 'convo-1',
			auth_state: 'authenticated',
			approval_state: 'granted',
			followup_state: 'ready',
			can_send_followup: true,
		});

		const merged = mergeWorkerManifest(normalized, {
			browser: {
				session_context: {
					provider: 'other_provider',
					session_url: 'https://example.com',
				},
			},
		});

		expect(merged.browser?.session_context).toMatchObject({
			provider: 'chatgpt_web',
			session_url: 'https://chatgpt.com/c/example',
			conversation_id: 'convo-1',
			auth_state: 'authenticated',
		});
	});
});
