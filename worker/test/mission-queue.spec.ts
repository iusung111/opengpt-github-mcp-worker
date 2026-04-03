import { describe, expect, it } from 'vitest';
import type { JobProgressSnapshot, JobRecord, MissionRecord } from '../src/contracts';
import { buildMissionProgressSnapshot } from '../src/queue/missions/projections';
import { missionCanAutoApprove, reconcileMissionFromJobs } from '../src/queue/missions/reconcile';
import { handleMissionControl } from '../src/queue/missions/actions';

function makeMission(overrides: Partial<MissionRecord> = {}): MissionRecord {
	return {
		mission_id: 'mission-1',
		repo: 'iusung111/Project_OpenGPT',
		base_branch: 'main',
		title: 'Mission test',
		target_paths: [],
		status: 'queued',
		max_parallelism: 3,
		yolo_mode: false,
		lanes: [
			{
				lane_id: 'planner',
				title: 'Planner',
				role: 'planner',
				status: 'queued',
				depends_on_lane_ids: [],
				attempt: 0,
				current_job_id: null,
				launched_job_ids: [],
				updated_at: '2026-04-03T00:00:00.000Z',
			},
			{
				lane_id: 'worker',
				title: 'Worker',
				role: 'worker',
				status: 'queued',
				depends_on_lane_ids: ['planner'],
				attempt: 0,
				current_job_id: null,
				launched_job_ids: [],
				updated_at: '2026-04-03T00:00:00.000Z',
			},
		],
		detached_job_ids: [],
		notes: [],
		created_at: '2026-04-03T00:00:00.000Z',
		updated_at: '2026-04-03T00:00:00.000Z',
		last_scheduler_at: null,
		last_reconciled_at: null,
		...overrides,
	};
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		job_id: 'job-planner-a1',
		repo: 'iusung111/Project_OpenGPT',
		base_branch: 'main',
		target_paths: [],
		status: 'working',
		next_actor: 'worker',
		auto_improve_enabled: false,
		auto_improve_max_cycles: 0,
		auto_improve_cycle: 0,
		worker_manifest: {},
		review_findings: [],
		notes: ['Planner running'],
		created_at: '2026-04-03T00:00:00.000Z',
		last_transition_at: '2026-04-03T00:00:00.000Z',
		updated_at: '2026-04-03T00:00:00.000Z',
		...overrides,
	};
}

function makeJobProgress(jobId: string): JobProgressSnapshot {
	return {
		job_id: jobId,
		repo: 'iusung111/Project_OpenGPT',
		status: 'working',
		next_actor: 'worker',
		runnable: true,
		idle_reason: null,
		missing_requirements: [],
		missing_capabilities: [],
		work_branch: `agent/${jobId}`,
		pr_number: null,
		workflow_run_id: null,
		stale_reason: null,
		latest_note: null,
		recent_notes: [],
		recent_audits: [],
		run_summary: {
			run_id: jobId,
			job_id: jobId,
			title: 'Planner child',
			status: 'running',
			runnable: true,
			idle_reason: null,
			missing_requirements: [],
			missing_capabilities: [],
			progress_percent: 50,
			last_event: 'Planner child running',
			approval_reason: null,
			updated_at: '2026-04-03T00:00:00.000Z',
			workflow_run_id: null,
			pr_number: null,
			preview_id: null,
			control_state: null,
			interrupt_kind: null,
			interrupt_message: null,
		},
		blocking_state: { kind: 'none', reason: null, blocked_action: null, resume_hint: null },
		latest_notification: null,
		notification_counts: { idle: 0, pending_approval: 0, running: 1, paused: 0, cancelled: 0, interrupted: 0, completed: 0, failed: 0 },
		control_state: null,
		approval_request: null,
		browser_control: null,
		last_transition_at: '2026-04-03T00:00:00.000Z',
		last_reconciled_at: null,
		last_webhook_event_at: null,
		updated_at: '2026-04-03T00:00:00.000Z',
	};
}

describe('mission queue helpers', () => {
	it('marks independent lanes runnable and dependency lanes queued', () => {
		const mission = reconcileMissionFromJobs(makeMission(), new Map());
		expect(mission.lanes[0]?.status).toBe('runnable');
		expect(mission.lanes[1]?.status).toBe('queued');
		expect(mission.status).toBe('running');
	});

	it('tracks detached jobs and blocked lanes from child job state', () => {
		const mission = makeMission({
			lanes: [
				{
					lane_id: 'planner',
					title: 'Planner',
					role: 'planner',
					status: 'launched',
					depends_on_lane_ids: [],
					attempt: 1,
					current_job_id: 'job-planner-a1',
					launched_job_ids: ['job-planner-a1'],
					updated_at: '2026-04-03T00:00:00.000Z',
				},
			],
		});
		const plannerJob = makeJob({
			mission_id: 'mission-1',
			lane_id: 'planner',
			worker_manifest: {
				attention: {
					approval: {
						pending: true,
						request_id: 'req-1',
						status: 'requested',
						reason: 'Need non-destructive approval',
						blocked_action: 'job_control.resume',
					},
				},
			},
		});
		const orphanJob = makeJob({
			job_id: 'job-orphan-a1',
			mission_id: 'mission-1',
			lane_id: 'ghost',
		});
		const reconciled = reconcileMissionFromJobs(
			mission,
			new Map([
				[plannerJob.job_id, plannerJob],
				[orphanJob.job_id, orphanJob],
			]),
		);
		expect(reconciled.lanes[0]?.status).toBe('blocked');
		expect(reconciled.detached_job_ids).toContain('job-orphan-a1');
	});

	it('only auto-approves safe YOLO approval bundles', () => {
		expect(
			missionCanAutoApprove(
				makeJob({
					worker_manifest: {
						attention: {
							approval: {
								pending: true,
								request_id: 'req-safe',
								status: 'requested',
								blocked_action: 'job_control.resume',
								bundle: { approved_tools: ['job_control'] },
							},
						},
					},
				}),
			),
		).toBe(true);
		expect(
			missionCanAutoApprove(
				makeJob({
					worker_manifest: {
						attention: {
							approval: {
								pending: true,
								request_id: 'req-unsafe',
								status: 'requested',
								blocked_action: 'workflow_dispatch',
								bundle: { approved_tools: ['workflow_dispatch'] },
							},
						},
					},
				}),
			),
		).toBe(false);
	});

	it('does not bypass the YOLO denylist through mission reconcile control', async () => {
		const mission = makeMission({
			yolo_mode: true,
			lanes: [
				{
					lane_id: 'planner',
					title: 'Planner',
					role: 'planner',
					status: 'blocked',
					depends_on_lane_ids: [],
					attempt: 1,
					current_job_id: 'job-planner-a1',
					launched_job_ids: ['job-planner-a1'],
					updated_at: '2026-04-03T00:00:00.000Z',
				},
			],
		});
		const job = makeJob({
			mission_id: 'mission-1',
			lane_id: 'planner',
			worker_manifest: {
				attention: {
					approval: {
						pending: true,
						request_id: 'req-unsafe',
						status: 'requested',
						blocked_action: 'workflow_dispatch',
						bundle: { approved_tools: ['workflow_dispatch'] },
					},
				},
			},
		});
		let persistedJob: JobRecord | null = null;
		const response = await handleMissionControl(
			{
				getMission: async () => mission,
				getJob: async () => job,
				persistJob: async (nextJob) => {
					persistedJob = nextJob;
				},
				persistMission: async () => {},
				reconcileMission: async (nextMission) => nextMission,
				buildMissionProgressSnapshot: async () => ({ mission_id: mission.mission_id } as any),
				writeAudit: async () => {},
			} as any,
			{
				action: 'mission_control',
				mission_id: mission.mission_id,
				mission_control_action: 'reconcile',
			},
		);
		expect(response.status).toBe(200);
		expect(persistedJob).toBeNull();
		expect(job.worker_manifest?.attention?.approval?.pending).toBe(true);
	});

	it('builds mission progress snapshots with child lane progress', () => {
		const mission = reconcileMissionFromJobs(
			makeMission({
				lanes: [
					{
						lane_id: 'planner',
						title: 'Planner',
						role: 'planner',
						status: 'working',
						depends_on_lane_ids: [],
						attempt: 1,
						current_job_id: 'job-planner-a1',
						launched_job_ids: ['job-planner-a1'],
						updated_at: '2026-04-03T00:00:00.000Z',
					},
				],
			}),
			new Map([['job-planner-a1', makeJob({ mission_id: 'mission-1', lane_id: 'planner' })]]),
		);
		const snapshot = buildMissionProgressSnapshot(
			mission,
			new Map([['job-planner-a1', makeJobProgress('job-planner-a1')]]),
			null,
		);
		expect(snapshot.mission_id).toBe('mission-1');
		expect(snapshot.counts.working).toBe(1);
		expect(snapshot.lanes[0]?.child_progress?.job_id).toBe('job-planner-a1');
	});
});
