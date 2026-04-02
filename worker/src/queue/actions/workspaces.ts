import type { QueueResponse, QueueRequestContext } from './context';
import type { WorkspaceRecord } from '../../contracts';
import { buildWorkspaceRecord } from '../../queue-workspaces';
import { ensureSafeWorkspacePath } from '../../queue-helpers';
import { fail, jsonResponse, nowIso, ok } from '../../utils';
import { workspaceNotFound } from './context';

export async function handleWorkspaceRegister(context: QueueRequestContext, workspaceInput: Partial<WorkspaceRecord> & { repo_key?: string }): Promise<QueueResponse> {
	try {
		const timestamp = nowIso();
		const existing = workspaceInput.repo_key ? await context.getWorkspace(workspaceInput.repo_key) : null;
		const workspacePath = ensureSafeWorkspacePath(workspaceInput.workspace_path ?? '');
		const workspace = buildWorkspaceRecord({ ...(workspaceInput as WorkspaceRecord), workspace_path: workspacePath }, existing, timestamp);
		await context.putWorkspace(workspace);
		await context.setActiveWorkspace(workspace.repo_key);
		return jsonResponse(ok({ workspace }));
	} catch (error) {
		return jsonResponse(fail('invalid_workspace_path', error instanceof Error ? error.message : String(error)), 400);
	}
}

export async function handleWorkspaceActivate(context: QueueRequestContext, repoKey: string): Promise<QueueResponse> {
	const existing = await context.getWorkspace(repoKey);
	if (!existing) {
		return workspaceNotFound(repoKey);
	}
	existing.last_used_at = nowIso();
	await context.putWorkspace(existing);
	await context.setActiveWorkspace(existing.repo_key);
	return jsonResponse(ok({ workspace: existing }));
}

export async function handleWorkspaceGet(context: QueueRequestContext, repoKey: string): Promise<QueueResponse> {
	const workspace = await context.getWorkspace(repoKey);
	if (!workspace) {
		return workspaceNotFound(repoKey);
	}
	return jsonResponse(ok({ workspace }));
}
