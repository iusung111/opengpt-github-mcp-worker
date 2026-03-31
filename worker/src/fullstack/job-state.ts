import { mergeWorkerManifest } from '../job-manifest';
import { computeRunAttentionStatus } from '../queue-projections';
import { AppEnv, JobRecord, JobWorkerManifest } from '../types';
import { nowIso, queueJson } from '../utils';

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function getJobRecord(env: AppEnv, jobId: string): Promise<JobRecord | null> {
	const result = await queueJson(env, { action: 'job_get', job_id: jobId });
	if (!result.ok) {
		throw new Error(result.error ?? `failed to load job ${jobId}`);
	}
	return (result.data?.job as JobRecord | undefined) ?? null;
}

export async function queueJsonOrThrow(
	env: AppEnv,
	payload: Parameters<typeof queueJson>[1],
	fallbackMessage: string,
) {
	const result = await queueJson(env, payload);
	if (!result.ok) {
		throw new Error(result.error ?? result.code ?? fallbackMessage);
	}
	return result;
}

function sourceLayerForManifestSection(section: keyof JobWorkerManifest): 'mcp' | 'cloudflare' {
	return section === 'preview' ? 'cloudflare' : 'mcp';
}

function sectionStatusForAudit(manifest: Partial<JobWorkerManifest> | undefined, section: keyof JobWorkerManifest): string | null {
	const sectionValue = manifest?.[section];
	return isRecord(sectionValue) && typeof sectionValue.status === 'string' ? sectionValue.status : null;
}

function sectionMessageForAudit(section: keyof JobWorkerManifest, sectionStatus: string | null): string | null {
	if (!sectionStatus) {
		return null;
	}
	return `${section} is ${sectionStatus}.`;
}

export async function updateJobState(
	env: AppEnv,
	input: {
		jobId?: string;
		repoKey: string;
		workerManifest?: Partial<JobWorkerManifest>;
		status?: JobRecord['status'];
		nextActor?: JobRecord['next_actor'];
		workflowRunId?: number | null;
		lastError?: string;
	},
): Promise<void> {
	if (!input.jobId) {
		return;
	}
	const currentJob = await getJobRecord(env, input.jobId);
	const approvalPending = currentJob?.worker_manifest?.attention?.approval?.pending === true;
	const shouldClearApproval =
		approvalPending &&
		(input.status === 'working' || input.status === 'done' || input.status === 'failed');
	const mergedManifest = mergeWorkerManifest(currentJob?.worker_manifest ?? {}, input.workerManifest ?? {});
	if (shouldClearApproval) {
		mergedManifest.attention = {
			...(mergedManifest.attention ?? {}),
			approval: {
				...(mergedManifest.attention?.approval ?? {}),
				pending: false,
				cleared_at: nowIso(),
			},
		};
	}
	await queueJsonOrThrow(env, {
		action: 'job_upsert',
		job: {
			job_id: input.jobId,
			repo: input.repoKey,
			status: input.status,
			next_actor: input.nextActor,
			workflow_run_id: input.workflowRunId ?? undefined,
			last_error: input.lastError,
			worker_manifest: mergedManifest,
		},
	}, `failed to update job state for ${input.jobId}`);
	if (currentJob) {
		const projectedJob: JobRecord = {
			...currentJob,
			status: input.status ?? currentJob.status,
			next_actor: input.nextActor ?? currentJob.next_actor,
			workflow_run_id: input.workflowRunId === undefined ? currentJob.workflow_run_id : input.workflowRunId ?? undefined,
			last_error: input.lastError === undefined ? currentJob.last_error : input.lastError,
			worker_manifest: mergedManifest,
			updated_at: nowIso(),
		};
		if (input.status || input.nextActor || input.workflowRunId !== undefined || input.lastError !== undefined) {
			await queueJsonOrThrow(env, {
				action: 'audit_write',
				event_type: 'job_update_status',
				payload: {
					job_id: input.jobId,
					repo: input.repoKey,
					status: projectedJob.status,
					next_actor: projectedJob.next_actor,
					workflow_run_id: projectedJob.workflow_run_id ?? null,
					last_error: projectedJob.last_error ?? null,
					source_layer: 'system',
					attention_status: computeRunAttentionStatus(projectedJob),
				},
			}, `failed to write status audit for ${input.jobId}`);
		}
		for (const section of ['verification', 'preview', 'browser', 'desktop', 'runtime'] as Array<keyof JobWorkerManifest>) {
			const sectionStatus = sectionStatusForAudit(input.workerManifest, section);
			if (!sectionStatus) {
				continue;
			}
			await queueJsonOrThrow(env, {
				action: 'audit_write',
				event_type: 'job_manifest_notification',
				payload: {
					job_id: input.jobId,
					repo: input.repoKey,
					section,
					section_status: sectionStatus,
					workflow_run_id: projectedJob.workflow_run_id ?? null,
					preview_id: section === 'preview' ? projectedJob.worker_manifest.preview?.preview_id ?? null : null,
					source_layer: sourceLayerForManifestSection(section),
					attention_status: computeRunAttentionStatus(projectedJob),
					message: sectionMessageForAudit(section, sectionStatus),
					dedupe_key: `${input.jobId}:${section}:${sectionStatus}:${projectedJob.workflow_run_id ?? 'none'}`,
				},
			}, `failed to write ${section} audit for ${input.jobId}`);
		}
		if (shouldClearApproval) {
			await queueJsonOrThrow(env, {
				action: 'audit_write',
				event_type: 'job_attention_approval_cleared',
				payload: {
					job_id: input.jobId,
					repo: input.repoKey,
					source_layer: 'gpt',
					attention_status: computeRunAttentionStatus(projectedJob),
					message: 'Approval requirement cleared and work resumed.',
					dedupe_key: `approval_cleared:${input.jobId}:${projectedJob.updated_at}`,
				},
			}, `failed to write approval cleared audit for ${input.jobId}`);
		}
	}
}

export async function resolveRunIdFromInput(
	env: AppEnv,
	jobId: string | undefined,
	explicitRunId: number | undefined,
	section: 'execution' | 'verification' | 'desktop' | 'browser' | 'runtime' = 'execution',
): Promise<number> {
	if (typeof explicitRunId === 'number' && Number.isFinite(explicitRunId)) {
		return explicitRunId;
	}
	if (!jobId) {
		throw new Error('run_id or job_id is required');
	}
	const job = await getJobRecord(env, jobId);
	if (!job) {
		throw new Error(`job not found: ${jobId}`);
	}
	const manifest = job.worker_manifest ?? {};
	const scopedSection = isRecord(manifest[section]) ? manifest[section] : {};
	const execution = isRecord(manifest.execution) ? manifest.execution : {};
	const candidate =
		scopedSection.run_id ??
		execution.run_id ??
		(isRecord(execution.last_workflow_run) ? execution.last_workflow_run.run_id : null) ??
		job.workflow_run_id;
	const runId =
		typeof candidate === 'string' ? Number(candidate) : typeof candidate === 'number' ? candidate : NaN;
	if (!Number.isFinite(runId) || runId <= 0) {
		throw new Error(`workflow run id is not recorded for job ${jobId}`);
	}
	return runId;
}
