export * from './utils_new';

import { AppEnv } from './types';
import { fail } from './utils_new/mcp';
import { jsonResponse } from './utils_new/common';
import { normalizeWorkflowInputs } from './utils_new/env';
import { sha256Hex } from './utils_new/crypto';
import { queueJson as queueJsonInternal } from './utils_new/github';

export const queueJson = queueJsonInternal;

function mapQueueErrorStatus(code: string | null | undefined): number {
  switch (code) {
    case 'bad_request':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
    case 'workspace_not_found':
      return 404;
    case 'invalid_state':
    case 'conflict':
      return 409;
    default:
      return 500;
  }
}

export async function queueFetch(env: AppEnv, payload: object): Promise<Response> {
  const recordPayload =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const result = await queueJsonInternal(env, recordPayload);
  return jsonResponse(
    result.ok
      ? result
      : fail(result.code ?? 'queue_fetch_failed', result.error ?? 'queue fetch failed'),
    result.ok ? 200 : mapQueueErrorStatus(result.code),
  );
}

export function getChatgptMcpDocumentationUrl(_env: Partial<AppEnv>): string | null {
  return 'https://github.com/iusung111/opengpt-github-mcp-worker/blob/main/docs/CHATGPT_MCP.md';
}

function parseEnvMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getAuditRetentionCount(env: Partial<AppEnv>): number {
  const parsed = Number(env.AUDIT_RETENTION_COUNT?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}

export function getDeliveryRetentionCount(env: Partial<AppEnv>): number {
  const parsed = Number(env.DELIVERY_RETENTION_COUNT?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}

export function getDispatchDedupeWindowMs(env: Partial<AppEnv>): number {
  return parseEnvMs(env.DISPATCH_DEDUPE_WINDOW_MS, 5 * 60 * 1000);
}

export function getReviewStaleAfterMs(env: Partial<AppEnv>): number {
  return parseEnvMs(env.REVIEW_STALE_AFTER_MS, 24 * 60 * 60 * 1000);
}

export function getWorkingStaleAfterMs(env: Partial<AppEnv>): number {
  return parseEnvMs(env.WORKING_STALE_AFTER_MS, 15 * 60 * 1000);
}

export function validateWorkflowInputs(inputs: Record<string, unknown>): void {
  normalizeWorkflowInputs(inputs);
}

export async function buildDispatchFingerprint(
  owner: string,
  repo: string,
  workflowId: string,
  ref: string,
  inputs: Record<string, unknown>,
  cycle = 0,
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      owner,
      repo,
      workflow_id: workflowId,
      ref,
      inputs: normalizeWorkflowInputs(inputs),
      cycle,
    }),
  );
}
