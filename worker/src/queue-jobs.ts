import { JobRecord, JobStatus, NextActor } from './types';
import { nowIso } from './utils';
import { JobIndexPointer, jobStatusIndexPrefix } from './queue-index';

export interface QueueJobListContext {
	ensureJobIndexes(): Promise<void>;
	getJob(jobId: string): Promise<JobRecord | null>;
	reconcileJob(job: JobRecord): Promise<JobRecord>;
	listJobIndexPointers(prefix: string): Promise<JobIndexPointer[]>;
	listStoredJobs(): Promise<JobRecord[]>;
}

export interface QueueJobUpsertContext {
	getJob(jobId: string): Promise<JobRecord | null>;
	persistJob(job: JobRecord, previous?: JobRecord | null): Promise<void>;
}

export function normalizeJob(input: Partial<JobRecord> & { job_id: string }): JobRecord {
	const timestamp = nowIso();
	return {
		job_id: input.job_id,
		repo: input.repo ?? '',
		base_branch: input.base_branch ?? 'main',
		work_branch: input.work_branch,
		pr_number: input.pr_number,
		workflow_run_id: input.workflow_run_id,
		operation_type: input.operation_type,
		target_paths: input.target_paths ?? [],
		status: input.status ?? 'queued',
		next_actor: input.next_actor ?? 'worker',
		auto_improve_enabled: input.auto_improve_enabled ?? false,
		auto_improve_max_cycles: input.auto_improve_max_cycles ?? 3,
		auto_improve_cycle: 0,
		worker_manifest: input.worker_manifest ?? {},
		review_findings: [],
		notes: input.notes ?? [],
		last_error: input.last_error,
		created_at: input.created_at ?? timestamp,
		updated_at: timestamp,
		last_transition_at: timestamp,
		last_reconciled_at: undefined,
		last_webhook_event_at: undefined,
		stale_reason: undefined,
	};
}

export async function upsertJob(
	context: QueueJobUpsertContext,
	job: Partial<JobRecord> & { job_id: string },
): Promise<void> {
	const existing = await context.getJob(job.job_id);
	if (existing) {
		const merged = { ...existing, ...job, updated_at: nowIso() };
		await context.persistJob(merged, existing);
		return;
	}
	await context.persistJob(normalizeJob(job));
}

export async function listJobs(
	context: QueueJobListContext,
	status?: JobStatus,
	nextActor?: NextActor,
): Promise<JobRecord[]> {
	const jobs: JobRecord[] = [];
	if (status || nextActor) {
		await context.ensureJobIndexes();
	}
	const indexedPointers = status || nextActor ? await context.listJobIndexPointers(jobStatusIndexPrefix(status, nextActor)) : null;
	const records: Array<JobRecord | null> = [];
	if (indexedPointers?.length) {
		for (const pointer of indexedPointers) {
			records.push(await context.getJob(pointer.job_id));
		}
	} else {
		records.push(...(await context.listStoredJobs()));
	}
	for (const value of records) {
		if (!value) {
			continue;
		}
		const reconciled = await context.reconcileJob(value);
		if (status && reconciled.status !== status) {
			continue;
		}
		if (nextActor && reconciled.next_actor !== nextActor) {
			continue;
		}
		jobs.push(reconciled);
	}
	return jobs.sort((left, right) => left.updated_at.localeCompare(right.updated_at));
}
