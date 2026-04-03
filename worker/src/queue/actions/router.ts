import type { JobRecord, QueueEnvelope } from '../../contracts';
import { fail, jsonResponse, ok } from '../../utils';
import type { QueueRequestContext, QueueResponse } from './context';
import { handleGitHubEvent } from './events';
import { handleCreatedJob, handleLoadedJob, handleJobAppendNote, handleJobEventFeed, handleJobProgress, handleJobsList, handleJobStatusUpdate } from './jobs';
import { handleMissionControl, handleMissionCreate, handleMissionEventFeed, handleMissionGet, handleMissionList, handleMissionProgress } from '../missions/actions';
import { handleJobControl, handleJobSubmitReview, handlePermissionRequestResolve } from './reviews';
import { handleWorkspaceActivate, handleWorkspaceGet, handleWorkspaceRegister } from './workspaces';

export async function handleQueueAction(context: QueueRequestContext, payload: QueueEnvelope, request: Request): Promise<QueueResponse | null> {
	switch (payload.action) {
		case 'job_create':
			if (!payload.job?.job_id) return null;
			await context.upsertJob(payload.job as JobRecord);
			return handleCreatedJob(context, payload.job.job_id);
		case 'job_upsert':
			if (!payload.job?.job_id) return null;
			await context.upsertJob(payload.job as JobRecord);
			return handleLoadedJob(context, payload.job.job_id);
		case 'job_get':
			return payload.job_id ? handleLoadedJob(context, payload.job_id, true) : null;
		case 'jobs_list':
			return handleJobsList(context, payload);
		case 'mission_create':
			return handleMissionCreate(context, payload);
		case 'mission_get':
			return payload.mission_id ? handleMissionGet(context, payload.mission_id) : null;
		case 'mission_list':
			return handleMissionList(context, payload);
		case 'mission_progress':
			return payload.mission_id ? handleMissionProgress(context, payload.mission_id) : null;
		case 'mission_event_feed':
			return payload.mission_id ? handleMissionEventFeed(context, payload) : null;
		case 'mission_control':
			return payload.mission_id && payload.mission_control_action ? handleMissionControl(context, payload) : null;
		case 'job_update_status':
			return payload.job_id && payload.status && payload.next_actor ? handleJobStatusUpdate(context, payload) : null;
		case 'job_control':
			return payload.job_id && payload.control_action ? handleJobControl(context, payload) : null;
		case 'job_append_note':
			return payload.job_id && payload.note ? handleJobAppendNote(context, payload.job_id, payload.note) : null;
		case 'permission_request_resolve':
			return payload.job_id && payload.request_id && payload.resolution ? handlePermissionRequestResolve(context, payload) : null;
		case 'job_submit_review':
			return payload.job_id && payload.review_verdict ? handleJobSubmitReview(context, payload) : null;
		case 'job_progress':
			return payload.job_id ? handleJobProgress(context, payload.job_id) : null;
		case 'job_event_feed':
			return handleJobEventFeed(context, payload);
		case 'workspace_register':
			return payload.workspace ? handleWorkspaceRegister(context, payload.workspace) : null;
		case 'workspace_activate':
			return payload.repo_key ? handleWorkspaceActivate(context, payload.repo_key) : null;
		case 'workspace_get':
			return payload.repo_key ? handleWorkspaceGet(context, payload.repo_key) : null;
		case 'workspace_list':
			return jsonResponse(ok({ active_repo_key: await context.getActiveWorkspaceRepoKey(), workspaces: await context.listWorkspaces() }));
		case 'workspace_find_similar':
			return jsonResponse(await context.findSimilarWorkspaces(payload.query, payload.repo_key));
		case 'audit_list':
			return jsonResponse(ok({ audits: await context.listAuditRecords(payload.event_type, payload.job_id, payload.limit) }));
		case 'audit_write':
			if (!payload.event_type || !payload.payload || typeof payload.payload !== 'object') return null;
			await context.writeAudit(payload.event_type, payload.payload);
			return jsonResponse(ok({ written: true, event_type: payload.event_type }));
		case 'github_event':
			return payload.payload && typeof payload.payload === 'object' ? handleGitHubEvent(context, payload, request) : null;
		default:
			return null;
	}
}
