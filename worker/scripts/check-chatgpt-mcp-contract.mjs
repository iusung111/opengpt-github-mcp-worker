import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const contract = JSON.parse(read('worker/config/chatgpt-mcp-contract.json'));
const docs = read('docs/CHATGPT_MCP.md');
const handlers = read('worker/src/runtime/mcp/handlers.ts');
const widgetResources = read('worker/src/mcp-widget-resources.ts');
const overviewTools = read('worker/src/mcp-overview-tools.ts');
const readObservability = read('worker/src/read-observability.ts');
const router = read('worker/src/runtime/router.ts');

assert(handlers.includes(`route: '${contract.route}'`), `runtime handler route mismatch: expected ${contract.route}`);
assert(
  handlers.includes(`buildMcpServer(env, { enableWidgets: true, profile: '${contract.profile_policy}' })`),
  `runtime handler profile mismatch: expected ${contract.profile_policy}`,
);
assert(widgetResources.includes(contract.widget_resource_uri), `widget resource URI missing: ${contract.widget_resource_uri}`);
assert(widgetResources.includes(contract.widget_mime_type), `widget mime type mismatch: expected ${contract.widget_mime_type}`);

for (const toolName of contract.required_widget_tools) {
  assert(overviewTools.includes(`'${toolName}'`) || overviewTools.includes(`\"${toolName}\"`), `required widget tool missing from overview surface: ${toolName}`);
  assert(docs.includes(toolName), `docs/CHATGPT_MCP.md is missing required tool reference: ${toolName}`);
}

for (const snippet of contract.required_docs_snippets) {
  assert(docs.includes(snippet), `docs/CHATGPT_MCP.md is missing required contract snippet: ${snippet}`);
}

for (const counterName of contract.health_blocked_counters) {
  assert(readObservability.includes(`${counterName}: 0`), `read observability counter missing: ${counterName}`);
}

assert(router.includes(`Response.redirect`), 'runtime router no longer redirects the root request');
assert(
  router.includes(`'/gui/'`) || router.includes('"/gui/"'),
  `runtime root redirect no longer targets ${contract.canonical_runtime_expectations.root_redirect}`,
);
for (const runtimePath of contract.canonical_runtime_expectations.runtime_owned_prefixes) {
  assert(router.includes(runtimePath), `runtime router no longer owns expected path: ${runtimePath}`);
}
for (const staticPath of contract.canonical_runtime_expectations.static_gui_paths_delegate_to_asset_layer) {
  assert(!router.includes(`url.pathname === '${staticPath}'`), `runtime router unexpectedly captured static GUI path: ${staticPath}`);
}

console.log(JSON.stringify({ ok: true, checked: 'chatgpt_mcp_contract' }, null, 2));
