import { JobRecord, WorkspaceRecord } from './types';
import { activeWorkspaceStorageKey, jobStorageKey, workspaceStorageKey } from './queue-helpers';
import { buildJobIndexEntries, jobIndexReadyKey } from './queue-index';

export interface QueueStoreContext {
	getStorage<T>(key: string): Promise<T | null>;
	putStorage(key: string, value: unknown): Promise<void>;
	deleteStorage(keys: string[] | string): Promise<void>;
	listJobs(): Promise<JobRecord[]>;
	reconcileJob(job: JobRecord): Promise<JobRecord>;
}

export async function getJob(context: QueueStoreContext, jobId: string): Promise<JobRecord | null> {
	return (await context.getStorage<JobRecord>(jobStorageKey(jobId))) ?? null;
}

export async function ensureJobIndexes(context: QueueStoreContext): Promise<void> {
	const ready = await context.getStorage<boolean>(jobIndexReadyKey());
	if (ready) {
		return;
	}
	const records = await context.listJobs();
	for (const job of records) {
		for (const [key, value] of buildJobIndexEntries(job)) {
			await context.putStorage(key, value);
		}
	}
	await context.putStorage(jobIndexReadyKey(), true);
}

export async function persistJob(
	context: QueueStoreContext,
	job: JobRecord,
	previous?: JobRecord | null,
): Promise<void> {
	const previousEntries = new Map(previous ? buildJobIndexEntries(previous) : []);
	const nextEntries = new Map(buildJobIndexEntries(job));
	const keysToDelete: string[] = [];
	for (const key of previousEntries.keys()) {
		if (!nextEntries.has(key)) {
			keysToDelete.push(key);
		}
	}
	if (keysToDelete.length > 0) {
		await context.deleteStorage(keysToDelete);
	}
	await context.putStorage(jobStorageKey(job.job_id), job);
	for (const [key, value] of nextEntries.entries()) {
		await context.putStorage(key, value);
	}
}

export async function getWorkspace(context: QueueStoreContext, repoKey: string): Promise<WorkspaceRecord | null> {
	return (await context.getStorage<WorkspaceRecord>(workspaceStorageKey(repoKey))) ?? null;
}

export async function getActiveWorkspaceRepoKey(context: QueueStoreContext): Promise<string | null> {
	return (await context.getStorage<string>(activeWorkspaceStorageKey())) ?? null;
}

export async function findJob(
	context: QueueStoreContext,
	matcher: (job: JobRecord) => boolean,
	options: { reconcile?: boolean } = {},
): Promise<JobRecord | null> {
	const records = await context.listJobs();
	for (const value of records) {
		if (!matcher(value)) {
			continue;
		}
		return options.reconcile === false ? value : context.reconcileJob(value);
	}
	return null;
}
