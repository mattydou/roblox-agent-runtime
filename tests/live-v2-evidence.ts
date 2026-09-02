import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

if (process.env.ROBLOX_AGENT_LIVE_V2_TEST !== '1') {
  console.log('SKIP: set ROBLOX_AGENT_LIVE_V2_TEST=1 to opt in to the V2 managed-evidence smoke test.');
  process.exit(0);
}

const suffix = randomUUID().slice(0, 8);
const runtimeDir = path.join(os.tmpdir(), `roblox-agent-v2-live-${suffix}`);
const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ROBLOX_AGENT_RUNTIME_DIR: runtimeDir };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/server.js')], cwd: process.cwd(), env, stderr: 'inherit', maxBufferSize: 32 * 1024 * 1024 });
const client = new Client({ name: 'roblox-agent-v2-live-smoke', version: '0.3.0' }, { capabilities: {} });
const rootName = `__RobloxAgentEvidence_${suffix}`;
const scriptName = `${rootName}_Script`;
const clientScriptName = `${rootName}_Client`;
const toolName = `${rootName}_Tool`;
const transientName = `${rootName}_Transient`;
const rootPath = `game.Workspace.${rootName}`;
let created = false;
let sessionId: string | undefined;

function parse(result: CallToolResult): Record<string, unknown> {
  const block = result.content.find((item) => item.type === 'text');
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>, allowError = false): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000, resetTimeoutOnProgress: true }) as CallToolResult;
  const body = parse(result);
  if (result.isError && !allowError) throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  return body;
}

function resultPath(value: unknown, name: string): string | undefined {
  const matches: string[] = [];
  const visit = (item: unknown): string | undefined => {
    if (Array.isArray(item)) for (const child of item) { const found = visit(child); if (found) return found; }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (record.name === name && typeof record.path === 'string') matches.push(record.path);
      for (const child of Object.values(record)) { const found = visit(child); if (found) return found; }
    }
    return undefined;
  };
  visit(value);
  return matches.find((item) => (item.includes('.Backpack.') || !item.includes('StarterPack')) && item.endsWith(`.${name}`)) ?? matches[0];
}

try {
  await client.connect(transport);
  await call('roblox_edit', { operations: [
    { op: 'create', id: 'root', class_name: 'Folder', parent: 'game.Workspace', name: rootName },
    { op: 'create', id: 'moving', class_name: 'Part', parent: '$root', name: 'Moving', properties: { Anchored: true, Position: { type: 'Vector3', x: 0, y: 5, z: 0 } } },
    { op: 'create', id: 'counter', class_name: 'NumberValue', parent: '$root', name: 'Counter', properties: { Value: 0 } },
    { op: 'create', id: 'remote', class_name: 'RemoteEvent', parent: '$root', name: 'Trigger' },
    { op: 'create', class_name: 'Tool', parent: 'game.StarterPack', name: toolName, properties: { RequiresHandle: false, CanBeDropped: false } },
    { op: 'create', class_name: 'LocalScript', parent: 'game.StarterPlayer.StarterPlayerScripts', name: clientScriptName, source: `
game:GetService("UserInputService").InputBegan:Connect(function(input, processed)
  if processed or input.KeyCode ~= Enum.KeyCode.E then return end
  local root = workspace:FindFirstChild(${JSON.stringify(rootName)})
  local remote = root and root:FindFirstChild("Trigger")
  if remote then remote:FireServer() end
end)
` },
    { op: 'create', class_name: 'Script', parent: 'game.ServerScriptService', name: scriptName, source: `
local root = workspace:WaitForChild(${JSON.stringify(rootName)})
root.Trigger.OnServerEvent:Connect(function()
  local transient = Instance.new("Part") transient.Name = ${JSON.stringify(transientName)} transient.Parent = root
  root.Counter.Value += 1
  root.Moving.Position += Vector3.new(5, 0, 0)
  task.wait(0.1)
  transient:Destroy()
end)
` },
  ] });
  created = true;

  const begun = await call('roblox_test', { mode: 'solo', action: 'begin_session', play_mode: 'play' });
  sessionId = (begun.session as Record<string, unknown>).id as string;
  const found = await call('roblox_inspect', { mode: 'search', context: 'client-1', query: toolName, search_by: 'name', max_results: 20 });
  const toolPath = resultPath(found, toolName);
  if (!toolPath) throw new Error('temporary Tool was not found in client runtime');
  const first = await call('roblox_test', { mode: 'solo', action: 'run_batch', session_id: sessionId, batch: {
    watches: [
      { id: 'transient', kind: 'instance_lifecycle', context: 'server', path: rootPath, name: transientName, class_name: 'Part' },
      { id: 'counter_change', kind: 'property_change', context: 'server', path: `${rootPath}.Counter`, property: 'Value' },
    ],
    series: [{ id: 'position_trace', probe: { kind: 'property', context: 'server', path: `${rootPath}.Moving`, property: 'Position' }, interval_ms: 50, duration_ms: 1000 }],
    checkpoints: [{ id: 'client_state', phase: 'after', probes: [{ id: 'client_root', kind: 'exists', context: 'client-1', path: rootPath }] }],
    actions: [
      { kind: 'keyboard', target: 'client-1', key_code: 'E', action: 'tap', duration_ms: 100 },
      { kind: 'wait', duration_ms: 500 },
    ],
    assertions: [
      { id: 'short_lived', evidence: 'transient', condition: 'exact_count', expected: 1 },
      { id: 'counter_once', evidence: 'counter_change', condition: 'exact_numeric_delta', expected: 1 },
      { id: 'moved', evidence: 'position_trace', condition: 'changed' },
      { id: 'replicated', evidence: 'client_root', condition: 'exists' },
    ],
  } });
  if (first.success !== true) throw new Error(`native watch/series evidence failed: ${JSON.stringify(first)}`);
  console.log('PASS reused one session for server/client probes, a short-lived instance watch, property delta, and Position series');

  const activated = await call('roblox_test', { mode: 'solo', action: 'run_batch', session_id: sessionId, batch: {
    watches: [{ id: 'activated', kind: 'signal', context: 'client-1', path: toolPath, signal: 'Activated' }],
    actions: [
      { kind: 'wait', duration_ms: 100 },
      { kind: 'tool', context: 'client-1', operation: 'equip', target: toolName },
      { kind: 'tool', context: 'client-1', operation: 'activate', target: toolName },
      { kind: 'tool', context: 'client-1', operation: 'unequip' },
      { kind: 'wait', duration_ms: 100 },
    ],
    assertions: [{ id: 'activated_once', evidence: 'activated', condition: 'exact_count', expected: 1 }],
  } });
  if (activated.success !== true) throw new Error(`Tool activation evidence failed: ${JSON.stringify(activated)}`);
  console.log('PASS proved zero activation during the pre-wait, one explicit Tool activation, and no additional activation after unequip');

  await call('roblox_edit', { operations: [{ op: 'modify', target: `${rootPath}.Moving`, properties: { Transparency: 0.1 } }] });
  const stale = await call('roblox_test', { mode: 'solo', action: 'run_batch', session_id: sessionId, batch: {}, refresh_stale: false }, true);
  if (stale.error_code !== 'TEST_SESSION_STALE') throw new Error(`persistent edit did not mark the session stale: ${JSON.stringify(stale)}`);
  console.log('PASS wrapper-mediated persistent edit marked the active runtime snapshot stale');

  const finished = await call('roblox_test', { mode: 'solo', action: 'finish_session', session_id: sessionId });
  sessionId = undefined;
  const cleanup = finished.cleanup as Record<string, unknown>;
  const harnesses = cleanup?.harnesses as Record<string, unknown>;
  if (cleanup?.owned_playtest_stopped !== true || !Array.isArray(harnesses?.remaining) || harnesses.remaining.length !== 0) throw new Error(`owned cleanup was not verified: ${JSON.stringify(finished)}`);
  console.log('PASS final logs and marked harness cleanup completed before one owned stop');
} finally {
  if (sessionId) await call('roblox_test', { mode: 'solo', action: 'finish_session', session_id: sessionId }, true).catch(() => undefined);
  if (created) {
    await call('roblox_edit', { operations: [
      { op: 'delete', target: `game.ServerScriptService.${scriptName}` },
      { op: 'delete', target: `game.StarterPlayer.StarterPlayerScripts.${clientScriptName}` },
      { op: 'delete', target: `game.StarterPack.${toolName}` },
      { op: 'delete', target: rootPath },
    ], continue_on_error: true });
    const residual = await call('roblox_inspect', { mode: 'search', query: rootName, search_by: 'name', max_results: 20 });
    if (Number(residual.count ?? 0) !== 0 || (Array.isArray(residual.results) && residual.results.length !== 0)) throw new Error(`temporary V2 live-test state remains: ${JSON.stringify(residual)}`);
    console.log('PASS verified no uniquely named persistent live-test artifacts remain');
  }
  await client.close().catch(() => undefined);
  await rm(runtimeDir, { recursive: true, force: true });
}
