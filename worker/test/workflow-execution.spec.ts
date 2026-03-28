import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetGitHubAuthCache } from '../src/github';
import { AppEnv } from '../src/types';
import { waitForWorkflowRun } from '../src/workflow-execution';

function buildStoredZip(entries: Array<{ name: string; text: string }>): Uint8Array {
	const encoder = new TextEncoder();
	const fileRecords: number[] = [];
	const centralRecords: number[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = Array.from(encoder.encode(entry.name));
		const dataBytes = Array.from(encoder.encode(entry.text));
		const localHeaderOffset = offset;
		const localHeader = [
			0x50, 0x4b, 0x03, 0x04,
			20, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0, 0, 0,
			...u32(dataBytes.length),
			...u32(dataBytes.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...dataBytes,
		];
		fileRecords.push(...localHeader);
		offset += localHeader.length;

		const centralHeader = [
			0x50, 0x4b, 0x01, 0x02,
			20, 0,
			20, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0, 0, 0,
			...u32(dataBytes.length),
			...u32(dataBytes.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(localHeaderOffset),
			...nameBytes,
		];
		centralRecords.push(...centralHeader);
	}

	const centralOffset = fileRecords.length;
	const eocd = [
		0x50, 0x4b, 0x05, 0x06,
		0, 0, 0, 0,
		...u16(entries.length),
		...u16(entries.length),
		...u32(centralRecords.length),
		...u32(centralOffset),
		...u16(0),
	];

	return new Uint8Array([...fileRecords, ...centralRecords, ...eocd]);
}

function u16(value: number): number[] {
	return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
	return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

afterEach(() => {
	resetGitHubAuthCache();
	vi.restoreAllMocks();
});

describe('workflow execution helpers', () => {
	it('matches completed workflow runs by request id when multiple candidates exist', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const env = {
			GITHUB_API_URL: 'https://api.github.test',
			GITHUB_APP_ID: '123',
			GITHUB_APP_INSTALLATION_ID: '456',
			GITHUB_APP_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
		} as AppEnv;
		const startedAt = '2026-03-28T00:00:00.000Z';
		const mismatchedSummaryZip = buildStoredZip([
			{
				name: 'summary.json',
				text: JSON.stringify({
					request: { request_id: 'req-other' },
				}),
			},
		]);
		const matchedSummaryZip = buildStoredZip([
			{
				name: 'summary.json',
				text: JSON.stringify({
					request: { request_id: 'req-target' },
				}),
			},
		]);

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url === 'https://api.github.test/app/installations/456/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'token-1',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/actions/runs?branch=main&event=workflow_dispatch&per_page=20') {
				return new Response(
					JSON.stringify({
						workflow_runs: [
							{
								id: 101,
								path: '.github/workflows/opengpt-exec.yml',
								created_at: '2026-03-28T00:00:01.000Z',
							},
							{
								id: 102,
								path: '.github/workflows/opengpt-exec.yml',
								created_at: '2026-03-28T00:00:02.000Z',
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/actions/runs/101') {
				return new Response(
					JSON.stringify({
						id: 101,
						status: 'completed',
						conclusion: 'success',
						html_url: 'https://github.example/runs/101',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/actions/runs/101/artifacts') {
				return new Response(
					JSON.stringify({
						artifacts: [{ id: 201, name: 'summary-101' }],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/actions/artifacts/201/zip') {
				return new Response(mismatchedSummaryZip, {
					status: 200,
					headers: { 'content-type': 'application/zip' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/actions/runs/102') {
				return new Response(
					JSON.stringify({
						id: 102,
						status: 'completed',
						conclusion: 'success',
						html_url: 'https://github.example/runs/102',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/actions/runs/102/artifacts') {
				return new Response(
					JSON.stringify({
						artifacts: [{ id: 202, name: 'summary-102' }],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/actions/artifacts/202/zip') {
				return new Response(matchedSummaryZip, {
					status: 200,
					headers: { 'content-type': 'application/zip' },
				});
			}
			return new Response(`unexpected url: ${url}`, { status: 404 });
		});

		await expect(
			waitForWorkflowRun(env, {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'opengpt-exec.yml',
				ref: 'main',
				started_at: startedAt,
				request_id: 'req-target',
				timeout_ms: 1_000,
			}),
		).resolves.toMatchObject({
			run_id: 102,
			conclusion: 'success',
			run_html_url: 'https://github.example/runs/102',
		});
	});
});
