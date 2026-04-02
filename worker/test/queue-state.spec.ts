import { describe, expect, it } from 'vitest';
import {
	canAdvanceJob,
	getControlState,
	getDispatchRequest,
	hasExecutionRelatedInterrupt,
	isDryRunJob,
	isSmokeTraceJob,
	pushJobNote,
	recordWorkflowSnapshot,
	transitionJob,
} from '../src/queue-state';
import { JobRecord } from '../src/contracts';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		job_id: 'job-1',
		repo: 'iusung111/OpenGPT',
		base_branch: 'main',
		target_paths: [],
		status: 'queued',
		next_actor: 'worker',
		auto_improve_enabled: false,
		auto_improve_max_cycles: 3,
		auto_improve_cycle: 0,
		worker_manifest: {},
		review_findings: [],
		notes: [],
		created_at: '2026-03-21T00:00:00.000Z',
		last_transition_at: '2026-03-21T00:00:00.000Z',
		updated_at: '2026-03-21T00:00:00.000Z',
		...overrides,
	};
}

describe('queue-state helpers', () => {
	it('transitions a job and updates last_transition_at', () => {
		const job = makeJob();
		transitionJob(job, 'working', 'system');
		expect(job.status).toBe('working');
		expect(job.next_actor).toBe('system');
		expect(job.last_transition_at).not.toBe('2026-03-21T00:00:00.000Z');
	});

	it('deduplicates notes', () => {
		const job = makeJob({ notes: ['existing'] });
		pushJobNote(job, 'existing');
		pushJobNote(job, 'new note');
		expect(job.notes).toEqual(['existing', 'new note']);
	});

	it('reads dispatch request and dry-run flag from worker manifest', () => {
		const job = makeJob({
			worker_manifest: {
				dispatch_request: {
					owner: 'iusung111',
					repo: 'OpenGPT',
					workflow_id: 'agent-run.yml',
					ref: 'main',
					inputs: { dry_run: 'true' },
					dispatched_at: '2026-03-21T00:00:00.000Z',
				},
			},
		});
		expect(getDispatchRequest(job)).toMatchObject({
			owner: 'iusung111',
			repo: 'OpenGPT',
			workflow_id: 'agent-run.yml',
		});
		expect(isDryRunJob(job)).toBe(true);
	});

	it('detects self-test smoke trace jobs from the queue surface', () => {
		const smokeJob = makeJob({
			job_id: 'smoke-003',
			operation_type: 'write_files',
			target_paths: ['notes/smoke-003.txt'],
		});
		const normalJob = makeJob({
			job_id: 'job-123',
			operation_type: 'write_files',
			target_paths: ['notes/todo.txt'],
		});

		expect(isSmokeTraceJob(smokeJob)).toBe(true);
		expect(isSmokeTraceJob(normalJob)).toBe(false);
	});

	it('records workflow snapshot in the worker manifest', () => {
		const job = makeJob();
		recordWorkflowSnapshot(job, {
			name: 'agent-run',
			status: 'completed',
			conclusion: 'success',
			html_url: 'https://github.com/example/run/1',
		});
		expect(job.worker_manifest).toMatchObject({
			last_workflow_run: {
				name: 'agent-run',
				status: 'completed',
				conclusion: 'success',
				html_url: 'https://github.com/example/run/1',
			},
		});
	});

	it('derives queue control state and interrupt semantics from the worker manifest', () => {
		const pausedJob = makeJob({
			worker_manifest: {
				control: {
					state: 'paused',
					reason: 'Waiting on operator confirmation',
				},
			},
		});
		const interruptedJob = makeJob({
			worker_manifest: {
				control: {
					last_interrupt: {
						kind: 'workflow_timed_out',
						source: 'workflow',
						recorded_at: '2026-03-21T00:00:01.000Z',
					},
				},
			},
		});

		expect(getControlState(pausedJob)).toMatchObject({
			state: 'paused',
			reason: 'Waiting on operator confirmation',
		});
		expect(canAdvanceJob(pausedJob)).toBe(false);
		expect(hasExecutionRelatedInterrupt(interruptedJob)).toBe(true);
	});
});

