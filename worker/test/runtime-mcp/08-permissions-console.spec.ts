import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDispatchFingerprint } from '../../src/utils';
import { getToolCatalog } from '../../src/tool-catalog';
import {
	createChatgptMcpClient,
	createDirectMcpBearerClient,
	createMcpClient,
	mcpAccessHeaders,
	queueJsonHeaders,
} from '../runtime-helpers';
import { buildStoredZip } from './test-zip-helpers';
describe('runtime mcp surface', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('builds a batch permission approval bundle', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'request_permission_bundle',
			arguments: {
				repos: ['iusung111/OpenGPT'],
				preset: 'implementation_with_workflow',
				reason: 'need one approval for branch creation, code edits, workflow rerun, and queue updates',
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				request_id: expect.any(String),
				status: 'drafted',
				bundle: {
					preset: {
						id: 'implementation_with_workflow',
					},
					repos: ['iusung111/OpenGPT'],
					approved_tools: expect.arrayContaining(['repo_create_branch', 'workflow_dispatch', 'job_append_note']),
				},
			},
		});
		await client.close();
	});

	it('links permission approval requests into the job event feed', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-approval-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
			},
		});

		const permissionResult = await client.callTool({
			name: 'request_permission_bundle',
			arguments: {
				repos: ['iusung111/OpenGPT'],
				preset: 'implementation_with_workflow',
				reason: 'Need approval to continue workflow execution',
				job_id: 'job-approval-1',
				blocked_action: 'workflow_dispatch',
			},
		});
		const permissionText = 'text' in permissionResult.content[0] ? permissionResult.content[0].text : '';
		expect(JSON.parse(permissionText)).toMatchObject({
			ok: true,
			data: {
				request_id: expect.any(String),
				status: 'requested',
				notification: {
					job_id: 'job-approval-1',
					status: 'pending_approval',
					blocked_action: 'workflow_dispatch',
				},
			},
		});
		expect((permissionResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.permission_bundle',
			request_id: expect.any(String),
			notification: {
				job_id: 'job-approval-1',
			},
		});

		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: { job_id: 'job-approval-1' },
		});
		const progressText = 'text' in progressResult.content[0] ? progressResult.content[0].text : '';
		expect(JSON.parse(progressText)).toMatchObject({
			ok: true,
			data: {
				progress: {
					run_summary: {
						status: 'pending_approval',
						approval_reason: 'Need approval to continue workflow execution',
					},
					blocking_state: {
						kind: 'approval',
						blocked_action: 'workflow_dispatch',
					},
				},
			},
		});

		const feedResult = await client.callTool({
			name: 'job_event_feed',
			arguments: {
				job_id: 'job-approval-1',
				status: 'pending_approval',
				limit: 10,
			},
		});
		const feedText = 'text' in feedResult.content[0] ? feedResult.content[0].text : '';
		const feedJson = JSON.parse(feedText);
		expect(feedJson.ok).toBe(true);
		expect(
			feedJson.data.items.some(
				(item: { source_layer: string; linked_refs?: { blocked_action?: string } }) =>
					item.source_layer === 'gpt' && item.linked_refs?.blocked_action === 'workflow_dispatch',
			),
		).toBe(true);
		await client.close();
	});

	it('records permission resolutions and exposes job control transitions', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-control-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
			},
		});

		const permissionResult = await client.callTool({
			name: 'request_permission_bundle',
			arguments: {
				repos: ['iusung111/OpenGPT'],
				preset: 'implementation_with_workflow',
				reason: 'Need approval before continuing the run',
				job_id: 'job-control-1',
				blocked_action: 'workflow_dispatch',
			},
		});
		const permissionText = 'text' in permissionResult.content[0] ? permissionResult.content[0].text : '';
		const permissionJson = JSON.parse(permissionText);
		const requestId = permissionJson.data.request_id as string;

		const rejectedResult = await client.callTool({
			name: 'permission_request_resolve',
			arguments: {
				job_id: 'job-control-1',
				request_id: requestId,
				resolution: 'rejected',
				note: 'Approval denied for now',
			},
		});
		const rejectedText = 'text' in rejectedResult.content[0] ? rejectedResult.content[0].text : '';
		expect(JSON.parse(rejectedText)).toMatchObject({
			ok: true,
			data: {
				request_id: requestId,
				status: 'rejected',
				notification: {
					job_id: 'job-control-1',
					status: 'interrupted',
					resolution: 'rejected',
				},
				current_progress: {
					run_summary: {
						status: 'interrupted',
						interrupt_kind: 'approval_rejected',
					},
					blocking_state: {
						kind: 'interrupted',
					},
				},
			},
		});
		expect((rejectedResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.permission_bundle',
			request_id: requestId,
			status: 'rejected',
			current_progress: {
				run_summary: {
					status: 'interrupted',
				},
			},
		});

		const pausedResult = await client.callTool({
			name: 'job_control',
			arguments: {
				job_id: 'job-control-1',
				action: 'pause',
				reason: 'Hold execution for manual review',
				expected_state: 'interrupted',
			},
		});
		const pausedText = 'text' in pausedResult.content[0] ? pausedResult.content[0].text : '';
		expect(JSON.parse(pausedText)).toMatchObject({
			ok: true,
			data: {
				action: 'pause',
				progress: {
					run_summary: {
						status: 'paused',
						control_state: 'paused',
					},
					blocking_state: {
						kind: 'paused',
						blocked_action: 'job_control.resume',
					},
				},
			},
		});
		expect((pausedResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.job_progress',
			action: 'pause',
			run_summary: {
				status: 'paused',
			},
		});

		const resumedResult = await client.callTool({
			name: 'job_control',
			arguments: {
				job_id: 'job-control-1',
				action: 'resume',
				expected_state: 'paused',
			},
		});
		const resumedText = 'text' in resumedResult.content[0] ? resumedResult.content[0].text : '';
		expect(JSON.parse(resumedText)).toMatchObject({
			ok: true,
			data: {
				action: 'resume',
				resume_strategy: 'refresh',
				progress: {
					run_summary: {
						status: 'idle',
						control_state: 'active',
						interrupt_kind: null,
					},
					blocking_state: {
						kind: 'none',
					},
				},
			},
		});

		const cancelledResult = await client.callTool({
			name: 'job_control',
			arguments: {
				job_id: 'job-control-1',
				action: 'cancel',
				reason: 'User cancelled the run',
				expected_state: 'idle',
			},
		});
		const cancelledText = 'text' in cancelledResult.content[0] ? cancelledResult.content[0].text : '';
		expect(JSON.parse(cancelledText)).toMatchObject({
			ok: true,
			data: {
				action: 'cancel',
				workflow_cancel: {
					attempted: false,
					cancelled: false,
				},
				progress: {
					run_summary: {
						status: 'cancelled',
						control_state: 'cancelled',
					},
					blocking_state: {
						kind: 'cancelled',
					},
				},
			},
		});
		await client.close();
	});

	it('builds repo-scoped incident bundles across all active jobs', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-incident-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
			},
		});
		await client.callTool({
			name: 'request_permission_bundle',
			arguments: {
				repos: ['iusung111/OpenGPT'],
				reason: 'Need approval before preview deploy',
				job_id: 'job-incident-1',
				blocked_action: 'preview_env_create',
			},
		});

		const bundleResult = await client.callTool({
			name: 'incident_bundle_create',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				scope: 'all_active',
				include_layer_logs: true,
			},
		});
		const bundleText = 'text' in bundleResult.content[0] ? bundleResult.content[0].text : '';
		expect(JSON.parse(bundleText)).toMatchObject({
			ok: true,
			data: {
				repo: 'iusung111/OpenGPT',
				scope: 'all_active',
				runs: expect.arrayContaining([
					expect.objectContaining({
						job_id: 'job-incident-1',
					}),
				]),
				layer_logs: expect.any(Array),
				error_logs: expect.any(Array),
			},
		});
		expect((bundleResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.incident_bundle',
			scope: 'all_active',
		});
		await client.close();
	});

	it('returns help guidance and request templates for supported work', async () => {
		const client = await createMcpClient();
		const defaultHelpResult = await client.callTool({
			name: 'help',
			arguments: {},
		});
		const defaultHelpText = 'text' in defaultHelpResult.content[0] ? defaultHelpResult.content[0].text : '';
		const defaultHelpPayload = JSON.parse(defaultHelpText);
		expect(defaultHelpPayload).toMatchObject({
			ok: true,
			data: {
				title: 'GitHub MCP work selection guide',
				recommended_workflow: 'real_change',
				request_checklist: expect.arrayContaining(['repo', 'request', 'target_paths']),
				reviewer_workflow: expect.arrayContaining(['call review_prepare_context when a branch or PR is ready for review']),
				review_finding_shape: {
					required: ['severity', 'file', 'summary', 'rationale'],
					optional: ['line_hint', 'required_fix'],
				},
				permission_bundle_recommendation: {
					preset: 'implementation_with_pr',
				},
				recommended_template: expect.objectContaining({
					label: 'Real change with PR',
				}),
				related_workflows: expect.arrayContaining(['main_ready', 'dry_run']),
			},
		});

		const mainHelpResult = await client.callTool({
			name: 'help',
			arguments: {
				query: 'main',
			},
		});
		const mainHelpText = 'text' in mainHelpResult.content[0] ? mainHelpResult.content[0].text : '';
		expect(JSON.parse(mainHelpText)).toMatchObject({
			ok: true,
			data: {
				recommended_workflow: 'main_ready',
				permission_bundle_recommendation: {
					preset: 'implementation_with_workflow',
				},
				recommended_template: {
					label: 'Main-ready change',
				},
			},
		});
		await client.close();
	});

});
