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

	it('serves MCP tools and queue actions over /mcp', async () => {
		const client = await createMcpClient();
		const tools = await client.listTools();
		const catalogToolNames = Array.from(
			new Set(getToolCatalog().groups.flatMap((group) => group.tools)),
		).sort();
		const runtimeToolNames = tools.tools.map((tool) => tool.name).sort();
		const widgetUri = 'ui://widget/notification-center.html';
		expect(runtimeToolNames).toEqual(catalogToolNames);
		for (const toolName of ["help","audit_list","branch_cleanup_candidates","branch_cleanup_execute","run_console_open","mission_create","mission_list","mission_progress","mission_event_feed","mission_control","job_progress","job_event_feed","job_control","repo_work_context","review_prepare_context","request_permission_bundle","permission_request_resolve","repo_navigation_manifest","repo_context_snapshot","repo_doc_index_lookup","repo_tool_index_lookup","repo_get_file_summary","repo_get_file_chunk","repo_get_diff","repo_get_file","repo_create_file","repo_upsert_file","repo_upload_start","repo_upload_commit","repo_batch_write","repo_apply_patchset","verify_list_suites","verify_run","preview_env_create","browser_session_start","browser_action_batch","desktop_build_run","api_contract_list","db_schema_inspect","runtime_log_query","deploy_promote","release_verify","workflow_allowlist_inspect","job_create","pr_merge","workspace_resolve"]) {
			expect(tools.tools.some((tool) => tool.name === toolName)).toBe(true);
		}

		for (const toolName of ["mission_create","mission_list","mission_progress","mission_event_feed","mission_control","job_progress","run_console_open","jobs_list","job_event_feed","job_control","request_permission_bundle","permission_request_resolve","incident_bundle_create","self_host_status"]) {
			expect(tools.tools.find((tool) => tool.name === toolName)?.outputSchema).toBeTruthy();
		}


		expect(tools.tools.find((tool) => tool.name === 'workflow_runs_list')?.description).toContain(
			'repo_key in owner/repo form',
		);
		expect(tools.tools.find((tool) => tool.name === 'workflow_runs_list')?.inputSchema).toMatchObject({
			properties: {
				repo_key: expect.any(Object),
				owner: expect.any(Object),
				repo: expect.any(Object),
			},
		});
		expect(
			tools.tools.find((tool) => tool.name === 'run_console_open')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Opening run console',
			'openai/toolInvocation/invoked': 'Run console ready',
		});
		expect(
			tools.tools.find((tool) => tool.name === 'job_event_feed')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Loading run events',
			'openai/toolInvocation/invoked': 'Run events ready',
		});
		expect(
			tools.tools.find((tool) => tool.name === 'request_permission_bundle')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Preparing approval bundle',
			'openai/toolInvocation/invoked': 'Approval bundle ready',
		});
		expect(
			tools.tools.find((tool) => tool.name === 'permission_request_resolve')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Recording approval outcome',
			'openai/toolInvocation/invoked': 'Approval outcome recorded',
		});
		expect(
			tools.tools.find((tool) => tool.name === 'job_control')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Updating run control state',
			'openai/toolInvocation/invoked': 'Run control state updated',
		});
		expect(
			tools.tools.find((tool) => tool.name === 'incident_bundle_create')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Collecting incident bundle',
			'openai/toolInvocation/invoked': 'Incident bundle ready',
		});
		expect(
			tools.tools.find((tool) => tool.name === 'self_host_status')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Loading self host status',
			'openai/toolInvocation/invoked': 'Self host status ready',
		});

		expect(tools.tools.find((tool) => tool.name === 'job_progress')?._meta).toMatchObject({
			ui: {
				resourceUri: widgetUri,
			},
			'openai/outputTemplate': widgetUri,
			'openai/widgetAccessible': true,
		});
		expect(tools.tools.find((tool) => tool.name === 'run_console_open')?._meta).toMatchObject({
			ui: {
				resourceUri: widgetUri,
			},
			'openai/outputTemplate': widgetUri,
			'openai/widgetAccessible': true,
		});
		expect(tools.tools.find((tool) => tool.name === 'job_event_feed')?._meta).toMatchObject({
			ui: {
				resourceUri: widgetUri,
			},
			'openai/outputTemplate': widgetUri,
			'openai/widgetAccessible': true,
		});

 		const resources = await client.listResources();
		expect(resources.resources.some((resource) => resource.uri === widgetUri)).toBe(true);
		const resourceResult = await client.readResource({ uri: widgetUri });
		const widgetResource = resourceResult.contents.find((resource) => resource.uri === widgetUri);
		expect(widgetResource).toBeTruthy();
		expect(widgetResource).toMatchObject({
			mimeType: 'text/html;profile=mcp-app',
			_meta: {
				ui: {
					prefersBorder: true,
				},
				'openai/widgetDescription': expect.any(String),
			},
		});
		expect('text' in (widgetResource ?? {}) ? widgetResource.text : '').toContain('/gui/app.js');

  		const createResult = await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-mcp-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-mcp-1',
				operation_type: 'run_commands',
				browser_session_seed: {
					provider: 'chatgpt_web',
					session_url: 'https://chatgpt.com/c/example',
					canonical_conversation_url: 'https://chatgpt.com/c/example?model=gpt-5',
					conversation_id: 'convo-123',
					auth_state: 'authenticated',
					can_send_followup: true,
				},
			},
		});
		const createText = 'text' in createResult.content[0] ? createResult.content[0].text : '';
		expect(JSON.parse(createText)).toMatchObject({
			ok: true,
			data: {
				job: {
					job_id: 'job-mcp-1',
					repo: 'iusung111/Project_OpenGPT',
					worker_manifest: {
						browser: {
							target: 'https://chatgpt.com/c/example',
							session_context: {
								provider: 'chatgpt_web',
								session_url: 'https://chatgpt.com/c/example',
								canonical_conversation_url: 'https://chatgpt.com/c/example?model=gpt-5',
								conversation_id: 'convo-123',
								auth_state: 'authenticated',
								approval_state: 'none',
								followup_state: 'ready',
								can_send_followup: true,
							},
						},
					},
				},
			},
		});

 		const getResult = await client.callTool({
			name: 'job_get',
			arguments: { job_id: 'job-mcp-1' },
		});
		const getText = 'text' in getResult.content[0] ? getResult.content[0].text : '';
		expect(JSON.parse(getText)).toMatchObject({
			ok: true,
			data: {
				job: {
					work_branch: 'agent/job-mcp-1',
					worker_manifest: {
						browser: {
							session_context: {
								conversation_id: 'convo-123',
							},
						},
					},
				},
			},
		});

  	const missionResult = await client.callTool({
			name: 'mission_create',
			arguments: {
				mission_id: 'mission-mcp-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				title: 'Mission from MCP',
				lanes: [
					{ lane_id: 'planner', title: 'Planner', role: 'planner', depends_on_lane_ids: [] },
					{ lane_id: 'worker', title: 'Worker', role: 'worker', depends_on_lane_ids: ['planner'] },
				],
			},
		});
		const missionText = 'text' in missionResult.content[0] ? missionResult.content[0].text : '';
		expect(JSON.parse(missionText)).toMatchObject({
			ok: true,
			data: {
				progress: {
					mission_id: 'mission-mcp-1',
					lanes: expect.arrayContaining([
						expect.objectContaining({
							lane_id: 'planner',
							current_job_id: expect.any(String),
						}),
					]),
					},
				},
			});
		expect((missionResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.mission_progress',
			progress: {
					mission_id: 'mission-mcp-1',
			},
		});

 		const openResult = await client.callTool({
			name: 'run_console_open',
			arguments: {
				include_healthz: true,
			},
		});
		const openText = 'text' in openResult.content[0] ? openResult.content[0].text : '';
		expect(JSON.parse(openText)).toMatchObject({
			ok: true,
			data: {
				gui_url: expect.stringContaining('/gui/'),
				missions: expect.arrayContaining([
					expect.objectContaining({
						mission_id: 'mission-mcp-1',
					}),
					]),
				jobs: expect.any(Array),
				include_healthz: true,
				selected_mission_id: expect.anything(),
				selected_mission_url: expect.stringContaining('/gui/?mission='),
				selected_job_id: expect.anything(),
				selected_job_url: expect.stringContaining('/gui/?job='),
			},
			});
		expect((openResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.jobs_list',
			gui_url: expect.stringContaining('/gui/'),
				missions: expect.any(Array),
				selected_mission_id: expect.anything(),
				selected_mission_url: expect.stringContaining('/gui/?mission='),
				jobs: expect.any(Array),
				selected_job_id: expect.anything(),
				selected_job_url: expect.stringContaining('/gui/?job='),
			});
		expect((openResult as { _meta?: Record<string, unknown> })._meta ?? {}).not.toHaveProperty('opengpt/widget');
		expect(
			(
				(openResult as { structuredContent?: { jobs?: Array<{ job_id?: string }> } }).structuredContent?.jobs ?? []
			).some((job) => job.job_id === 'smoke-003'),
		).toBe(false);

 		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-mcp-1',
				note: 'reading repo state',
			},
		});

 		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: { job_id: 'job-mcp-1' },
		});
		const progressText = 'text' in progressResult.content[0] ? progressResult.content[0].text : '';
		expect(JSON.parse(progressText)).toMatchObject({
			ok: true,
			data: {
				progress: {
					job_id: 'job-mcp-1',
					status: 'queued',
					latest_note: 'reading repo state',
					recent_notes: ['reading repo state'],
					run_summary: {
						run_id: 'job-mcp-1',
						status: 'idle',
					},
					blocking_state: {
						kind: 'none',
					},
					notification_counts: {
						idle: expect.any(Number),
					},
					},
				},
			});
		expect((progressResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.job_progress',
			run_summary: {
					run_id: 'job-mcp-1',
				},
			});

 		const eventFeedResult = await client.callTool({
			name: 'job_event_feed',
			arguments: {
				job_id: 'job-mcp-1',
				limit: 10,
            },
        });
		expect((eventFeedResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.job_event_feed',
			});
		expect((eventFeedResult as { _meta?: Record<string, unknown> })._meta).toMatchObject({
			'opengpt/widget': {
					kind: 'opengpt.notification_contract.job_event_feed',
				},
			});
		const eventFeedText = 'text' in eventFeedResult.content[0] ? eventFeedResult.content[0].text : '';
		expect(JSON.parse(eventFeedText)).toMatchObject({
			ok: true,
			data: {
				items: expect.any(Array),
				logs: expect.any(Array),
					counts: {
						idle: expect.any(Number),
					},
				},
			});

 		const selfHostStatusResult = await client.callTool({
			name: 'self_host_status',
			arguments: {
				include_healthz: true,
			},
		});
		expect((selfHostStatusResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.self_host_status',
			self_repo_key: 'iusung111/opengpt-github-mcp-worker',
			current_deploy: {
					environment: expect.any(String),
				},
			workflow_allowlist: {
					self_repo: expect.any(Array),
				},
			read_observability: {
					counters: expect.any(Object),
				},
			});
		expect((selfHostStatusResult as { _meta?: Record<string, unknown> })._meta).toMatchObject({
			'opengpt/widget': {
					kind: 'opengpt.notification_contract.self_host_status',
				},
			});

 		const auditResult = await client.callTool({
			name: 'audit_list',
			arguments: {
				job_id: 'job-mcp-1',
				limit: 5,
			},
		});
		const auditText = 'text' in auditResult.content[0] ? auditResult.content[0].text : '';
		const auditJson = JSON.parse(auditText);
		expect(auditJson.ok).toBe(true);
		expect(
			auditJson.data.audits.some(
				(item: { event_type: string; payload: { job_id?: string } }) =>
					item.event_type === 'job_create' && item.payload.job_id === 'job-mcp-1',
			),
		).toBe(true);
		expect(
			auditJson.data.audits.some(
				(item: { event_type: string; payload: { session_url?: string; conversation_id?: string | null } }) =>
					item.event_type === 'browser_session_seeded' &&
					item.payload.session_url === 'https://chatgpt.com/c/example' &&
					item.payload.conversation_id === 'convo-123',
			),
		).toBe(true);

 		const registerWorkspaceResult = await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '/home/uieseong/workspace/projects/opengpt-sandbox',
				aliases: ['opengpt'],
			},
		});
		const registerWorkspaceText =
			'text' in registerWorkspaceResult.content[0] ? registerWorkspaceResult.content[0].text : '';
		expect(JSON.parse(registerWorkspaceText)).toMatchObject({
			ok: true,
			data: {
				workspace: {
					repo_key: 'iusung111/Project_OpenGPT',
					workspace_path: '/home/uieseong/workspace/projects/opengpt-sandbox',
				},
			},
			});

 		const resolveWorkspaceResult = await client.callTool({
			name: 'workspace_resolve',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
			},
		});
		const resolveWorkspaceText =
			'text' in resolveWorkspaceResult.content[0] ? resolveWorkspaceResult.content[0].text : '';
		expect(JSON.parse(resolveWorkspaceText)).toMatchObject({
			ok: true,
			data: {
				repo_key: 'iusung111/Project_OpenGPT',
				existing_workspace: {
					repo_key: 'iusung111/Project_OpenGPT',
					workspace_path: '/home/uieseong/workspace/projects/opengpt-sandbox',
				},
				requires_confirmation: true,
				recommended_workspace_relative_path: 'projects/project-opengpt',
				recommended_workspace_kind: 'project',
				local_workspace_optional: true,
				},
			});
		await client.close();
	}, 10000);

	it('suppresses widget metadata on authenticated /chatgpt/mcp while keeping the full tool surface', async () => {
		const client = await createChatgptMcpClient();
		const tools = await client.listTools();

		expect(tools.tools.some((tool) => tool.name === 'repo_get_file_summary')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_update_file')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'workflow_dispatch')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'job_progress')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'run_console_open')).toBe(true);

		expect(tools.tools.find((tool) => tool.name === 'job_progress')?._meta ?? {}).not.toHaveProperty('openai/outputTemplate');
		expect(tools.tools.find((tool) => tool.name === 'job_progress')?._meta ?? {}).not.toHaveProperty('openai/widgetAccessible');
		expect(
			((tools.tools.find((tool) => tool.name === 'job_progress')?._meta as { ui?: Record<string, unknown> } | undefined)?.ui ??
				{}) as Record<string, unknown>,
		).not.toHaveProperty('resourceUri');
		expect(tools.tools.find((tool) => tool.name === 'run_console_open')?._meta ?? {}).not.toHaveProperty('openai/outputTemplate');

 		await expect(client.listResources()).rejects.toThrow('Method not found');
		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: { job_id: 'missing-job' },
		});
		expect((progressResult as { _meta?: Record<string, unknown> })._meta ?? {}).not.toHaveProperty('opengpt/widget');

		await client.close();
	}, 10000);

	it('returns api tool implementation paths from repo_tool_index_lookup for the self repo', async () => {
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker/git/trees/main?recursive=true') {
				return new Response(
					JSON.stringify({
						sha: 'main-tree-sha',
						tree: [
							{ path: 'worker/src/mcp/fullstack/api.ts', type: 'blob' },
							{ path: 'worker/src/runtime/mcp/handlers.ts', type: 'blob' },
							{ path: 'worker/src/tool-catalog.json', type: 'blob' },
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker/contents/worker/src/tool-catalog.json?ref=main') {
				return new Response(
					JSON.stringify({
						path: 'worker/src/tool-catalog.json',
						type: 'file',
						sha: 'tool-catalog-sha',
						content: Buffer.from(
							JSON.stringify({
								groups: [
									{
										id: 'api_backend',
										label: 'API and backend',
										tools: ['api_contract_list', 'api_contract_get', 'api_request_run', 'api_contract_validate'],
									},
								],
							}),
							'utf8',
						).toString('base64'),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(JSON.stringify({ message: `unexpected url: ${url}`, method: init?.method ?? 'GET' }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			});
		});

		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'repo_tool_index_lookup',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
				query: 'api',
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
				query: 'api',
				tool_paths: expect.arrayContaining([
					expect.objectContaining({
						path: 'worker/src/mcp/fullstack/api.ts',
						classification: 'tool',
					}),
				]),
				tool_entries: expect.arrayContaining([
					expect.objectContaining({
						tool_name: 'api_request_run',
						group_id: 'api_backend',
					}),
				]),
			},
		});

		await client.close();
	}, 10000);

});
