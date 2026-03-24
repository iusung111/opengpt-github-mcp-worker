import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDispatchFingerprint } from '../src/utils';
import { createChatgptMcpClient, createDirectMcpBearerClient, createMcpClient, queueJsonHeaders } from './runtime-helpers';

describe('runtime mcp surface', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('treats blocked reviews as terminal and respects review rework limit', async () => {
		const blockedClient = await createMcpClient();
		await blockedClient.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-review-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-review-1',
				auto_improve_enabled: true,
				auto_improve_max_cycles: 1,
			},
		});
		await blockedClient.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-review-1',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});
		const blockedResult = await blockedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-1',
				review_verdict: 'blocked',
				findings: [],
				next_action: 'security concern',
			},
		});
		const blockedText = 'text' in blockedResult.content[0] ? blockedResult.content[0].text : '';
		expect(JSON.parse(blockedText)).toMatchObject({
			ok: true,
			data: {
				job: {
					status: 'failed',
					next_actor: 'system',
					last_error: 'review blocked: security concern',
				},
			},
		});
		await blockedClient.close();

		const limitedClient = await createMcpClient();
		await limitedClient.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-review-2',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-review-2',
				auto_improve_enabled: true,
				auto_improve_max_cycles: 1,
			},
		});
		await limitedClient.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-review-2',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});
		const limitedResult = await limitedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-2',
				review_verdict: 'changes_requested',
				findings: [],
				next_action: 'needs another pass',
			},
		});
		const limitedText = 'text' in limitedResult.content[0] ? limitedResult.content[0].text : '';
		expect(JSON.parse(limitedText)).toMatchObject({
			ok: true,
			data: {
				job: {
					status: 'rework_pending',
					next_actor: 'worker',
					auto_improve_cycle: 1,
				},
			},
		});

		const cappedResult = await limitedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-2',
				review_verdict: 'changes_requested',
				findings: [],
				next_action: 'limit reached',
			},
		});
		const cappedText = 'text' in cappedResult.content[0] ? cappedResult.content[0].text : '';
		expect(JSON.parse(cappedText)).toMatchObject({
			ok: false,
			code: 'invalid_state',
			error: 'job is not waiting for reviewer input',
		});
		await limitedClient.close();
	});

	it('serves MCP tools and queue actions over /mcp', async () => {
		const client = await createMcpClient();
		const tools = await client.listTools();
		expect(tools.tools.some((tool) => tool.name === 'help')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'audit_list')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'branch_cleanup_candidates')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'branch_cleanup_execute')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'job_progress')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_work_context')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'review_prepare_context')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'request_permission_bundle')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_get_file')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'workflow_allowlist_inspect')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'job_create')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'pr_merge')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'workspace_resolve')).toBe(true);

		const createResult = await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-mcp-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-mcp-1',
				operation_type: 'run_commands',
			},
		});
		const createText = 'text' in createResult.content[0] ? createResult.content[0].text : '';
		expect(JSON.parse(createText)).toMatchObject({
			ok: true,
			data: {
				job: {
					job_id: 'job-mcp-1',
					repo: 'iusung111/OpenGPT',
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
				},
			},
		});

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
				},
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
					repo_key: 'iusung111/OpenGPT',
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
				repo_key: 'iusung111/OpenGPT',
				default_workspace_path: '/home/uieseong/workspace/projects/OpenGPT',
				existing_workspace: {
					repo_key: 'iusung111/OpenGPT',
					workspace_path: '/home/uieseong/workspace/projects/opengpt-sandbox',
				},
				requires_confirmation: true,
			},
		});
		await client.close();
	});

	it('inspects the effective workflow allowlist for a repository', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workflow_allowlist_inspect',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				repo_key: 'iusung111/OpenGPT',
				file_based_entries: ['build-todo-exe.yml'],
				effective_allowlist: expect.arrayContaining(['build-todo-exe.yml']),
				precedence: {
					rules: expect.any(Array),
				},
			},
		});
		await client.close();
	});

	it('serves the same read/write MCP surface over /chatgpt/mcp with bearer auth', async () => {
		const originalFetch = globalThis.fetch;
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
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/git/trees/main?recursive=false') {
				return new Response(
					JSON.stringify({
						sha: 'tree-sha',
						truncated: false,
						tree: [
							{ path: 'README.md', type: 'blob', sha: 'blob-readme' },
							{ path: 'project', type: 'tree', sha: 'tree-project' },
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/README.md') {
				return new Response(
					JSON.stringify({
						path: 'README.md',
						name: 'README.md',
						type: 'file',
						content: btoa('# OpenGPT\n'),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createChatgptMcpClient();
		const jobsListResult = await client.callTool({
			name: 'jobs_list',
			arguments: {},
		});
		const jobsListText = 'text' in jobsListResult.content[0] ? jobsListResult.content[0].text : '';
		expect(JSON.parse(jobsListText)).toMatchObject({
			ok: true,
			data: {
				jobs: expect.any(Array),
			},
		});

		const treeResult = await client.callTool({
			name: 'repo_list_tree',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				path: '',
				recursive: false,
			},
		});
		const treeText = 'text' in treeResult.content[0] ? treeResult.content[0].text : '';
		const treeJson = JSON.parse(treeText);
		expect(treeJson.ok).toBe(true);
		expect(Array.isArray(treeJson.data.tree)).toBe(true);

		const fileResult = await client.callTool({
			name: 'repo_get_file',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				path: 'README.md',
			},
		});
		const fileText = 'text' in fileResult.content[0] ? fileResult.content[0].text : '';
		expect(JSON.parse(fileText)).toMatchObject({
			ok: true,
			data: {
				path: 'README.md',
			},
		});
		await client.close();
	});

	it('reads and updates workflow files over /chatgpt/mcp', async () => {
		const originalFetch = globalThis.fetch;
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
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/.github/workflows/test.yml') {
				if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
					const payload = JSON.parse(String(init?.body ?? '{}'));
					return new Response(
						JSON.stringify({
							content: {
								path: '.github/workflows/test.yml',
								sha: 'workflow-blob-updated',
							},
							commit: {
								sha: 'commit-workflow-update',
								message: payload.message,
							},
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				return new Response(
					JSON.stringify({
						path: '.github/workflows/test.yml',
						name: 'test.yml',
						type: 'file',
						content: btoa('name: test\non: workflow_dispatch\n'),
						encoding: 'base64',
						sha: 'workflow-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createChatgptMcpClient();
		const workflowFileResult = await client.callTool({
			name: 'repo_get_file',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				path: '.github/workflows/test.yml',
			},
		});
		const workflowFileText =
			'text' in workflowFileResult.content[0] ? workflowFileResult.content[0].text : '';
		expect(JSON.parse(workflowFileText)).toMatchObject({
			ok: true,
			data: {
				path: '.github/workflows/test.yml',
				decoded_text: 'name: test\non: workflow_dispatch\n',
			},
		});

		const workflowUpdateResult = await client.callTool({
			name: 'repo_update_file',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				branch: 'agent/workflow-edit-test',
				path: '.github/workflows/test.yml',
				message: 'Update workflow from MCP',
				content_b64: btoa('name: test\non: workflow_dispatch\njobs: {}\n'),
				expected_blob_sha: 'workflow-blob-sha',
			},
		});
		const workflowUpdateText =
			'text' in workflowUpdateResult.content[0] ? workflowUpdateResult.content[0].text : '';
		expect(JSON.parse(workflowUpdateText)).toMatchObject({
			ok: true,
			data: {
				content: {
					path: '.github/workflows/test.yml',
				},
				commit: {
					message: 'Update workflow from MCP',
				},
			},
		});
		await client.close();
	});

	it('allows repo read and branch write operations for the backup mirror repository', async () => {
		const originalFetch = globalThis.fetch;
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
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/contents/README.md') {
				if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
					const payload = JSON.parse(String(init?.body ?? '{}'));
					return new Response(
						JSON.stringify({
							content: {
								path: 'README.md',
								sha: 'backup-readme-updated',
							},
							commit: {
								sha: 'backup-commit-sha',
								message: payload.message,
							},
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				return new Response(
					JSON.stringify({
						path: 'README.md',
						name: 'README.md',
						type: 'file',
						content: btoa('# Backup Repo\n'),
						encoding: 'base64',
						sha: 'backup-readme-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const readResult = await client.callTool({
			name: 'repo_get_file',
			arguments: {
				owner: 'iusung111',
				repo: 'opengpt-github-mcp-worker-mirror-backup',
				path: 'README.md',
			},
		});
		const readText = 'text' in readResult.content[0] ? readResult.content[0].text : '';
		expect(JSON.parse(readText)).toMatchObject({
			ok: true,
			data: {
				path: 'README.md',
				decoded_text: '# Backup Repo\n',
			},
		});

		const writeResult = await client.callTool({
			name: 'repo_update_file',
			arguments: {
				owner: 'iusung111',
				repo: 'opengpt-github-mcp-worker-mirror-backup',
				branch: 'agent/backup-write-test',
				path: 'README.md',
				message: 'Verify backup repo MCP write path',
				content_b64: btoa('# Backup Repo\n\nMCP write path verified.\n'),
				expected_blob_sha: 'backup-readme-sha',
			},
		});
		const writeText = 'text' in writeResult.content[0] ? writeResult.content[0].text : '';
		expect(JSON.parse(writeText)).toMatchObject({
			ok: true,
			data: {
				content: {
					path: 'README.md',
				},
				commit: {
					message: 'Verify backup repo MCP write path',
				},
			},
		});
		await client.close();
	});

	it('serves the direct /mcp surface for bearer-authenticated ChatGPT callers', async () => {
		const client = await createDirectMcpBearerClient();
		const jobsListResult = await client.callTool({
			name: 'jobs_list',
			arguments: {},
		});
		const jobsListText = 'text' in jobsListResult.content[0] ? jobsListResult.content[0].text : '';
		expect(JSON.parse(jobsListText)).toMatchObject({
			ok: true,
			data: {
				jobs: expect.any(Array),
			},
		});
		await client.close();
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
				status: 'ready_for_approval',
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

	it('keeps a single active workspace and sorts workspace_list by active repo first', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '/home/uieseong/workspace/repos/sandbox/OpenGPT',
			},
		});
		await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
				workspace_path: '/home/uieseong/workspace/opengpt-github-mcp-worker',
			},
		});

		await client.callTool({
			name: 'workspace_activate',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
			},
		});
		let listResult = await client.callTool({
			name: 'workspace_list',
			arguments: {},
		});
		let listText = 'text' in listResult.content[0] ? listResult.content[0].text : '';
		let listJson = JSON.parse(listText);
		expect(listJson).toMatchObject({
			ok: true,
			data: {
				active_repo_key: 'iusung111/OpenGPT',
			},
		});
		expect(listJson.data.workspaces[0]).toMatchObject({
			repo_key: 'iusung111/OpenGPT',
			is_active: true,
		});
		expect(listJson.data.workspaces[1]).toMatchObject({
			repo_key: 'iusung111/opengpt-github-mcp-worker',
			is_active: false,
		});

		await client.callTool({
			name: 'workspace_activate',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
			},
		});
		listResult = await client.callTool({
			name: 'workspace_list',
			arguments: {},
		});
		listText = 'text' in listResult.content[0] ? listResult.content[0].text : '';
		listJson = JSON.parse(listText);
		expect(listJson).toMatchObject({
			ok: true,
			data: {
				active_repo_key: 'iusung111/opengpt-github-mcp-worker',
			},
		});
		expect(listJson.data.workspaces[0]).toMatchObject({
			repo_key: 'iusung111/opengpt-github-mcp-worker',
			is_active: true,
		});
		expect(listJson.data.workspaces[1]).toMatchObject({
			repo_key: 'iusung111/OpenGPT',
			is_active: false,
		});
		await client.close();
	});

	it('returns a concise job progress snapshot with recent notes and audits', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-progress-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-progress-1',
			},
		});
		await client.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-progress-1',
				status: 'working',
				next_actor: 'system',
			},
		});
		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-progress-1',
				note: 'inspecting branch cleanup candidates',
			},
		});
		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-progress-1',
				note: 'verifying open PR state',
			},
		});

		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: {
				job_id: 'job-progress-1',
			},
		});
		const progressText = 'text' in progressResult.content[0] ? progressResult.content[0].text : '';
		const progressJson = JSON.parse(progressText);
		expect(progressJson).toMatchObject({
			ok: true,
			data: {
				progress: {
					job_id: 'job-progress-1',
					latest_note: 'verifying open PR state',
					recent_notes: ['inspecting branch cleanup candidates', 'verifying open PR state'],
				},
			},
		});
		expect(
			progressJson.data.progress.recent_audits.some(
				(item: { event_type: string }) => item.event_type === 'job_append_note',
			),
		).toBe(true);
		await client.close();
	});

	it('retains only the most recent audit records per configured limit', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-audit-retention',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
			},
		});
		for (let index = 0; index < 6; index += 1) {
			await client.callTool({
				name: 'job_append_note',
				arguments: {
					job_id: 'job-audit-retention',
					note: `note-${index}`,
				},
			});
		}

		const auditResult = await client.callTool({
			name: 'audit_list',
			arguments: {
				job_id: 'job-audit-retention',
				limit: 10,
			},
		});
		const auditText = 'text' in auditResult.content[0] ? auditResult.content[0].text : '';
		const auditJson = JSON.parse(auditText);
		expect(auditJson.ok).toBe(true);
		expect(auditJson.data.audits).toHaveLength(5);
		expect(auditJson.data.audits.at(-1).event_type).toBe('job_append_note');
		expect(
			auditJson.data.audits.some(
				(item: { event_type: string; payload: { note?: string } }) =>
					item.payload.note === 'note-0',
			),
		).toBe(false);
		await client.close();
	});

	it('returns specific failure code when workflow dispatch is not allowlisted', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workflow_dispatch',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'not-allowed.yml',
				ref: 'main',
				inputs: {},
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			code: 'workflow_not_allowlisted',
		});
		await client.close();
	});

	it('returns specific failure code when workflow file has no workflow_dispatch trigger', async () => {
		const originalFetch = globalThis.fetch;
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
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/actions/workflows/pr-merge.yml') {
				return new Response(
					JSON.stringify({
						id: 1,
						name: 'pr-merge',
						path: '.github/workflows/pr-merge.yml',
						state: 'active',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/.github/workflows/pr-merge.yml?ref=main') {
				return new Response(
					JSON.stringify({
						path: '.github/workflows/pr-merge.yml',
						name: 'pr-merge.yml',
						type: 'file',
						content: btoa('name: pr-merge\non:\n  pull_request:\n    types: [opened]\n'),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workflow_dispatch',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'pr-merge.yml',
				ref: 'main',
				inputs: {
					pull_number: '29',
					merge_method: 'squash',
					delete_branch: true,
				},
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			code: 'workflow_missing_dispatch_trigger',
		});
		await client.close();
	});

	it('deduplicates repeated workflow dispatch requests for the same working job', async () => {
		const originalFetch = globalThis.fetch;
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
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/actions/workflows/agent-run.yml') {
				return new Response(
					JSON.stringify({
						id: 2,
						name: 'agent-run',
						path: '.github/workflows/agent-run.yml',
						state: 'active',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/.github/workflows/agent-run.yml?ref=main') {
				return new Response(
					JSON.stringify({
						path: '.github/workflows/agent-run.yml',
						name: 'agent-run.yml',
						type: 'file',
						content: btoa('name: agent-run\non:\n  workflow_dispatch:\n'),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const inputs = {
			job_id: 'job-dispatch-dedupe',
			operation_type: 'run_commands',
			base_branch: 'main',
			target_paths: '',
			instructions_b64: 'eyJjb21tYW5kcyI6W1sicHdkIl1dfQ==',
			dry_run: true,
			auto_improve: true,
		};
		const fingerprint = await buildDispatchFingerprint(
			'iusung111',
			'OpenGPT',
			'agent-run.yml',
			'main',
			inputs,
			0,
		);

		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-dispatch-dedupe',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				status: 'working',
				next_actor: 'system',
				workflow_run_id: 999,
				auto_improve_cycle: 0,
				worker_manifest: {
					dispatch_request: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						workflow_id: 'agent-run.yml',
						ref: 'main',
						inputs,
						fingerprint,
						dispatched_at: new Date().toISOString(),
					},
					last_workflow_run: {
						status: 'queued',
						conclusion: null,
						html_url: null,
					},
				},
			}),
		});

		const result = await client.callTool({
			name: 'workflow_dispatch',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'agent-run.yml',
				ref: 'main',
				inputs,
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				deduplicated: true,
			},
		});
		await client.close();
	});

	it('rejects unsafe workspace registration paths', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '../unsafe',
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			code: 'queue_action_failed',
		});
		await client.close();
	});
});
