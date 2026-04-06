import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const contract = JSON.parse(fs.readFileSync(path.join(root, 'worker/config/chatgpt-mcp-contract.json'), 'utf8'));

const appUrl = String(process.env.APP_URL ?? '').replace(/\/$/, '');
const expectedCommitSha = String(process.env.EXPECTED_COMMIT_SHA ?? '').trim();
const expectedDeployEnvironment = String(process.env.EXPECT_DEPLOY_ENV ?? 'mirror').trim();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(relativePath, init) {
  const response = await fetch(`${appUrl}${relativePath}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

function pickTools(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.tools)) return payload.tools;
  if (payload.result && typeof payload.result === 'object' && Array.isArray(payload.result.tools)) return payload.result.tools;
  return [];
}

function pickToolNames(payload) {
  return pickTools(payload)
    .map((tool) => (tool && typeof tool === 'object' ? tool.name : null))
    .filter((value) => typeof value === 'string');
}

function healthCounter(healthPayload, counterName) {
  return Number(healthPayload?.read_observability?.counters?.[counterName] ?? NaN);
}

async function main() {
  assert(appUrl, 'APP_URL is required');

  const beforeHealth = await requestJson('/healthz');
  assert(beforeHealth.response.ok, `/healthz failed before smoke: ${beforeHealth.response.status}`);
  assert(beforeHealth.json?.deploy_environment === expectedDeployEnvironment, `deploy_environment mismatch: expected ${expectedDeployEnvironment}, got ${beforeHealth.json?.deploy_environment}`);
  if (expectedCommitSha) {
    assert(beforeHealth.json?.release_commit_sha === expectedCommitSha, `release_commit_sha mismatch: expected ${expectedCommitSha}, got ${beforeHealth.json?.release_commit_sha}`);
  }

  const bootstrap = await requestJson(contract.route);
  assert(bootstrap.response.status === 200, `GET ${contract.route} did not return 200`);

  const initialize = await requestJson(contract.route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mirror-smoke', version: '1.0.0' } } }),
  });
  assert(initialize.response.status === 200, `initialize did not return 200: ${initialize.response.status}`);

  const toolsList = await requestJson(contract.route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert(toolsList.response.status === 200, `tools/list did not return 200: ${toolsList.response.status}`);
  const toolNames = pickToolNames(toolsList.json);
  assert(toolNames.length > 0, 'tools/list returned no tools');
  assert(
    contract.required_write_tool_candidates.some((toolName) => toolNames.includes(toolName)),
    `tools/list did not expose any required write-capable tool: ${contract.required_write_tool_candidates.join(', ')}`,
  );

  const unauthorizedWriteProbe = await requestJson(contract.route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: contract.required_write_tool_candidates[0], arguments: {} } }),
  });
  assert(unauthorizedWriteProbe.response.status === 401, `unauthenticated tools/call did not return 401: ${unauthorizedWriteProbe.response.status}`);
  assert(
    (unauthorizedWriteProbe.response.headers.get('www-authenticate') ?? '').includes('Bearer'),
    'unauthenticated tools/call did not include a Bearer challenge',
  );

  const afterHealth = await requestJson('/healthz');
  assert(afterHealth.response.ok, `/healthz failed after smoke: ${afterHealth.response.status}`);
  if (expectedCommitSha) {
    assert(afterHealth.json?.release_commit_sha === expectedCommitSha, `release_commit_sha changed after smoke: expected ${expectedCommitSha}, got ${afterHealth.json?.release_commit_sha}`);
  }
  for (const counterName of contract.health_blocked_counters) {
    assert(healthCounter(afterHealth.json, counterName) === 0, `${counterName} is not zero after smoke`);
  }

  console.log(JSON.stringify({
    ok: true,
    route: contract.route,
    app_url: appUrl,
    deploy_environment: afterHealth.json?.deploy_environment ?? null,
    release_commit_sha: afterHealth.json?.release_commit_sha ?? null,
    write_tools_seen: contract.required_write_tool_candidates.filter((toolName) => toolNames.includes(toolName)),
    blocked_counters: Object.fromEntries(contract.health_blocked_counters.map((counterName) => [counterName, healthCounter(afterHealth.json, counterName)])),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
