export * from './utils_new';

import { AppEnv } from './types';
import { fail, jsonResponse } from './utils_new/mcp';
import { getChatgptMcpIssuer, normalizeWorkflowInputs } from './utils_new/env';
import { sha256Hex } from './utils_new/crypto';
import { queueJson as queueJsonInternal } from './utils_new/github';

export const queueJson = queueJsonInternal;

export async function queueFetch(env: AppEnv, payload: object): Promise<Response> {
  const result = await queueJsonInternal(env, payload);
  return jsonResponse(
    result.ok
      ? result
      : fail(result.code ?? 'queue_fetch_failed', result.error ?? 'queue fetch failed'),
    result.ok ? 200 : 500,
  );
}

export function getChatgptMcpDocumentationUrl(env: Partial<AppEnv>): string | null {
  const issuer = getChatgptMcpIssuer(env as AppEnv);
  return issuer ? issuer.replace(/\/$/, '') : null;
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
