import { describe, expect, it } from 'vitest';
import { ensureJobIndexes, findJob, getActiveWorkspaceRepoKey, getJob, getWorkspace, persistJob } from '../src/queue-store';
import { activeWorkspaceStorageKey, workspaceStorageKey } from '../src/queue-helpers';
import { jobIndexReadyKey, jobRunIndexKey } from '../src/queue-index';
import { JobRecord, WorkspaceRecord } from '../src/contracts';

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

function createContext(storedJobs: JobRecord[] = []) {
	const store = new Map<string, unknown>();
	for (const job of storedJobs) {
		store.set(`job:${job.job_id}`, job);
	}
	return {
		store,
		context: {
			getStorage: async <T>(key: string) => (store.get(key) as T | undefined) ?? null,
			putStorage: async (key: string, value: unknown) => {
				store.set(key, value);
			},
			deleteStorage: async (keys: string[] | string) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					store.delete(key);
				}
			},
			listJobs: async () => Array.from(store.entries())
				.filter(([key]) => key.startsWith('job:'))
				.map(([, value]) => value as JobRecord),
			reconcileJob: async (job: JobRecord) => ({ ...job, status: 'done' as const }),
		},
	};
}

describe('queue-store helpers', () => {
	it('loads stored job and workspace values by derived keys', async () => {
		const { context, store } = createContext([makeJob()]);
		store.set(workspaceStorageKey('iusung111/OpenGPT'), { repo_key: 'iusung111/OpenGPT', workspace_path: 'd:/VScode/repos/sandbox/OpenGPT' });
		store.set(activeWorkspaceStorageKey(), 'iusung111/OpenGPT');

		await expect(getJob(context, 'job-1')).resolves.toMatchObject({ job_id: 'job-1' });
		await expect(getWorkspace(context, 'iusung111/OpenGPT')).resolves.toMatchObject({
			repo_key: 'iusung111/OpenGPT',
		});
		await expect(getActiveWorkspaceRepoKey(context)).resolves.toBe('iusung111/OpenGPT');
	});

	it('normalizes and self-heals legacy workspace records on read', async () => {
		const { context, store } = createContext();
		const legacyWorkspace: WorkspaceRecord = {
			repo_key: 'iusung111/OpenGPT',
			repo_slug: 'opengpt',
			display_name: 'OpenGPT',
			aliases: [],
			workspace_path: 'D:\\VScode\\projects\\OpenGPT\\',
			created_at: '2026-03-21T00:00:00.000Z',
			updated_at: '2026-03-21T00:00:00.000Z',
		};
		store.set(workspaceStorageKey('iusung111/OpenGPT'), legacyWorkspace);

		await expect(getWorkspace(context, 'iusung111/OpenGPT')).resolves.toMatchObject({
			workspace_path: 'D:/VScode/projects/OpenGPT',
		});
		expect(store.get(workspaceStorageKey('iusung111/OpenGPT'))).toMatchObject({
			workspace_path: 'D:/VScode/projects/OpenGPT',
		});
	});

	it('backfills indexes once and marks the index ready flag', async () => {
		const { context, store } = createContext([
			makeJob({ workflow_run_id: 123, work_branch: 'agent/task-job-1-123', status: 'working', next_actor: 'system' }),
		]);

		await ensureJobIndexes(context);

		expect(store.get(jobIndexReadyKey())).toBe(true);
		expect(store.get(jobRunIndexKey('iusung111/OpenGPT', 123))).toEqual({ job_id: 'job-1' });
	});

	it('persists updated indexes and removes stale ones', async () => {
		const original = makeJob({ workflow_run_id: 123, work_branch: 'agent/task-job-1-123' });
		const updated = makeJob({ workflow_run_id: 456, work_branch: 'agent/task-job-1-456' });
		const { context, store } = createContext();

		await persistJob(context, original);
		await persistJob(context, updated, original);

		expect(store.has(jobRunIndexKey('iusung111/OpenGPT', 123))).toBe(false);
		expect(store.get(jobRunIndexKey('iusung111/OpenGPT', 456))).toEqual({ job_id: 'job-1' });
	});

	it('supports raw and reconciled findJob lookups', async () => {
		const { context } = createContext([makeJob({ status: 'working' })]);

		const raw = await findJob(context, (job) => job.status === 'working', { reconcile: false });
		const reconciled = await findJob(context, (job) => job.status === 'working');

		expect(raw?.status).toBe('working');
		expect(reconciled?.status).toBe('done');
	});
});

