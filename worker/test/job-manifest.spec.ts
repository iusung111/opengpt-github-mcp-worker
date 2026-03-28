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
});
