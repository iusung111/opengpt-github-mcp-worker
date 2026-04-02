import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import { decodeToken, type PreviewTokenPayload } from '../../state-tokens';
import {
	downloadWorkflowArtifactEntries,
	downloadWorkflowLogEntries,
	listWorkflowArtifacts,
} from '../../workflow-execution';
import { getSelfRepoKey } from '../../utils';
import { buildErrorFingerprint } from '../../fullstack/logic';

export function toIsoTimestamp(input: number): string {
	return new Date(input).toISOString();
}

function decodeBytes(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function normalizeArtifacts(artifacts: Array<Record<string, unknown>>): string[] {
	return artifacts
		.map((artifact) => {
			const id = artifact.id;
			if (typeof id === 'number') return String(id);
			if (typeof id === 'string' && id.trim()) return id.trim();
			return '';
		})
		.filter(Boolean);
}

export const incidentBundleStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.incident_bundle'),
		bundle_id: z.string(),
		repo: z.string(),
		scope: z.enum(['job', 'all_active']),
		run_id: z.number().int().positive().optional(),
		summary: z.object({}).passthrough().nullable().optional(),
		artifacts: z.array(z.object({}).passthrough()).optional(),
		preview: z.object({}).passthrough().nullable().optional(),
		browser: z.object({}).passthrough().nullable().optional(),
		runs: z.array(z.object({}).passthrough()).optional(),
		layer_logs: z.array(z.object({}).passthrough()).optional(),
		error_logs: z.array(z.object({}).passthrough()).optional(),
	})
	.passthrough();

export const browserActionSchema = z.object({
	action: z.enum([
		'goto',
		'click',
		'type',
		'select',
		'press',
		'wait_for',
		'assert_text',
		'assert_visible',
		'assert_url',
		'snapshot',
	]),
	selector: z.string().optional(),
	value: z.string().optional(),
	url: z.string().optional(),
	expected_text: z.string().optional(),
	timeout_ms: z.number().int().positive().max(60000).optional(),
});

export const dbMutationSchema = {
	owner: z.string(),
	repo: z.string(),
	ref: z.string().optional(),
	job_id: z.string().optional(),
	wait_timeout_seconds: z.number().int().positive().max(900).default(300),
};

export function firstObjectUrl(urls: Record<string, string>): string | null {
	for (const value of Object.values(urls)) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

export async function collectRuntimeErrorClusters(
	env: AppEnv,
	owner: string,
	repo: string,
	runId: number,
	limit: number,
): Promise<Array<Record<string, unknown>>> {
	const entries = await downloadWorkflowLogEntries(env, owner, repo, runId);
	const clusters = new Map<string, { count: number; samples: string[]; files: Set<string> }>();
	for (const [fileName, bytes] of entries) {
		for (const line of decodeBytes(bytes).split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || !/(error|exception|failed|panic)/i.test(trimmed)) {
				continue;
			}
			const fingerprint = buildErrorFingerprint(trimmed);
			const existing = clusters.get(fingerprint) ?? { count: 0, samples: [], files: new Set<string>() };
			existing.count += 1;
			existing.files.add(fileName);
			if (existing.samples.length < 3) {
				existing.samples.push(trimmed);
			}
			clusters.set(fingerprint, existing);
		}
	}
	return Array.from(clusters.entries())
		.map(([fingerprint, value]) => ({
			fingerprint,
			count: value.count,
			files: Array.from(value.files).sort(),
			samples: value.samples,
		}))
		.sort((left, right) => Number(right.count) - Number(left.count))
		.slice(0, limit);
}

export async function readGuiCaptureDiagnosticFiles(env: AppEnv, runId: number): Promise<Record<string, unknown>> {
	const repoKey = getSelfRepoKey(env);
	const [owner, repo] = repoKey.split('/');
	const artifacts = await listWorkflowArtifacts(env, owner, repo, runId);
	for (const artifact of artifacts) {
		const artifactId = typeof artifact.id === 'number' ? artifact.id : Number(artifact.id);
		if (!Number.isFinite(artifactId) || artifactId <= 0) {
			continue;
		}
		const entries = await downloadWorkflowArtifactEntries(env, owner, repo, artifactId);
		const consoleEntry = entries.get('logs/console.json');
		const pageErrorsEntry = entries.get('logs/page-errors.json');
		const networkErrorsEntry = entries.get('logs/network-errors.json');
		if (consoleEntry || pageErrorsEntry || networkErrorsEntry) {
			return {
				console: consoleEntry ? JSON.parse(decodeBytes(consoleEntry)) : [],
				page_errors: pageErrorsEntry ? JSON.parse(decodeBytes(pageErrorsEntry)) : [],
				network_errors: networkErrorsEntry ? JSON.parse(decodeBytes(networkErrorsEntry)) : [],
			};
		}
	}
	return { console: [], page_errors: [], network_errors: [] };
}

export async function resolveApiTargetUrl(
	env: AppEnv,
	previewToken: string | undefined,
	appUrl: string | undefined,
	requestPath: string | undefined,
): Promise<string> {
	if (previewToken) {
		const preview = await decodeToken<PreviewTokenPayload>(env, previewToken, 'preview');
		const baseUrl = firstObjectUrl(preview.urls);
		if (!baseUrl) {
			throw new Error('preview token does not include a target URL');
		}
		return new URL(requestPath?.trim() || '/', baseUrl).toString();
	}
	if (appUrl?.trim()) {
		return requestPath?.trim() ? new URL(requestPath.trim(), appUrl.trim()).toString() : appUrl.trim();
	}
	throw new Error('preview_token or app_url is required');
}

export async function fetchPreviewHealth(url: string, healthcheckPath?: string | null): Promise<Record<string, unknown>> {
	const targetUrl = healthcheckPath ? new URL(healthcheckPath, url).toString() : url;
	const response = await fetch(targetUrl, { method: 'GET', redirect: 'follow' });
	return {
		url: targetUrl,
		status: response.status,
		ok: response.ok,
	};
}
