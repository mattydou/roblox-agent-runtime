import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

if (process.env.ROBLOX_AGENT_LIVE_V4_TEST !== '1' || process.env.ROBLOX_AGENT_LIVE_DISPOSABLE !== '1') {
  console.log('UNVERIFIED: set ROBLOX_AGENT_LIVE_V4_TEST=1 and ROBLOX_AGENT_LIVE_DISPOSABLE=1 only for a disposable Studio place.');
  process.exit(0);
}

const suffix = randomUUID().slice(0, 8);
const marker = `__RobloxAgentV4_${suffix}`;
const rootPath = `game.Workspace.${marker}`;
const runtimeDir = path.join(os.tmpdir(), `roblox-agent-v4-live-${suffix}`);
const env = { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string')), ROBLOX_AGENT_RUNTIME_DIR: runtimeDir };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/server.js')], cwd: process.cwd(), env, stderr: 'inherit', maxBufferSize: 48 * 1024 * 1024 });
const client = new Client({ name: 'roblox-agent-v4-live-acceptance', version: '0.5.0' }, { capabilities: {} });
let created = false;
let connectedStudio = false;

function body(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((item) => item.type === 'text');
  return JSON.parse(text?.type === 'text' ? text.text : '{}') as Record<string, unknown>;
}
async function raw(name: string, args: Record<string, unknown>, allowError = false): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000, resetTimeoutOnProgress: true }) as CallToolResult;
  if (result.isError && !allowError) throw new Error(`${name} failed: ${JSON.stringify(body(result))}`);
  return result;
}
async function call(name: string, args: Record<string, unknown>, allowError = false): Promise<Record<string, unknown>> { return body(await raw(name, args, allowError)); }

try {
  await client.connect(transport);
  const status = await call('roblox_inspect', { mode: 'status' });
  connectedStudio = JSON.stringify(status).includes('place');
  if (!connectedStudio) throw new Error(`no compatible Studio place was reported: ${JSON.stringify(status)}`);

  const edit = await call('roblox_edit', { source: `
local root = Instance.new("Folder")
root.Name = ${JSON.stringify(marker)}
root:SetAttribute("RobloxAgentV4Disposable", true)
root.Parent = workspace
local remote = Instance.new("RemoteEvent")
remote.Name = "Request"
remote.Parent = root
for index = 1, 8 do
  local part = Instance.new("Part")
  part.Name = "Generated" .. index
  part.Anchored = true
  part.Position = Vector3.new(index * 4, 2, 0)
  part.Parent = root
end
return { root = root, created = 8 }
`, timeout_ms: 15_000 });
  if (edit.success !== true) throw new Error(`compact edit Luau failed: ${JSON.stringify(edit)}`);
  created = true;

  const readBack = await call('roblox_inspect', { mode: 'hierarchy', path: rootPath, depth: 1, max_results: 20 });
  if (!JSON.stringify(readBack).includes('Generated8')) throw new Error(`edit read-back was incomplete: ${JSON.stringify(readBack)}`);

  const scenarioResult = await raw('roblox_test', { mode: 'solo', action: 'run_scenario', required_roles: ['server', 'client-1'], batch: {
    actions: [
      { id: 'serverReady', kind: 'luau', role: 'server', source: `local root=workspace:WaitForChild(${JSON.stringify(marker)}); root:SetAttribute("Requests",0); _G[${JSON.stringify(marker)}]=root.Request.OnServerEvent:Connect(function() root:SetAttribute("Requests",root:GetAttribute("Requests")+1) end); return "ready"` },
      { id: 'clientSent', kind: 'luau', role: 'client-1', source: `workspace:WaitForChild(${JSON.stringify(marker)}).Request:FireServer(); return true` },
      { kind: 'wait', duration_ms: 200 },
      { id: 'serverCount', kind: 'luau', role: 'server', source: `return workspace:WaitForChild(${JSON.stringify(marker)}):GetAttribute("Requests")` },
      { kind: 'screenshot', format: 'jpeg', quality: 80 },
    ],
    checkpoints: [{ id: 'after', probes: [{ id: 'rootExists', kind: 'exists', context: 'server', path: rootPath }] }],
    assertions: [
      { id: 'serverInstalled', evidence: 'serverReady', condition: 'equals', expected: 'ready' },
      { id: 'clientRequested', evidence: 'clientSent', condition: 'equals', expected: true },
      { id: 'crossContext', evidence: 'serverCount', condition: 'equals', expected: 1 },
      { id: 'runtimeRoot', evidence: 'rootExists', condition: 'exists' },
    ],
  } });
  const scenario = body(scenarioResult);
  if (scenario.success !== true || scenarioResult.content.filter((item) => item.type === 'image').length !== 1) throw new Error(`one-shot integration scenario failed: ${JSON.stringify(scenario)}`);
  if (!Array.isArray(scenario.runtime_errors) || !(scenario.logs as Record<string, unknown>)?.entries || !(scenario.cleanup as Record<string, unknown>)?.owned_playtest_stopped) throw new Error(`scenario logs/cleanup were not verified: ${JSON.stringify(scenario)}`);
  const cleanup = await call('roblox_edit', { source: `local root=workspace:FindFirstChild(${JSON.stringify(marker)}); if not root or root:GetAttribute("RobloxAgentV4Disposable") ~= true then return false end; root:Destroy(); return true` });
  if (cleanup.success !== true || cleanup.value !== true) throw new Error(`marked persistent cleanup failed: ${JSON.stringify(cleanup)}`);
  const absent = await call('roblox_inspect', { mode: 'search', query: marker, search_by: 'name', max_results: 10 });
  if (JSON.stringify(absent).includes(rootPath)) throw new Error(`persistent cleanup read-back still found ${rootPath}`);
  created = false;
  console.log('PASS compact edit Luau, read-back, managed client/server integration, screenshot, logs, and verified cleanup');
} catch (error) {
  if (!connectedStudio && !created) console.log(`UNVERIFIED: compatible connected Studio/plugin unavailable (${error instanceof Error ? error.message : String(error)})`);
  else throw error;
} finally {
  if (created) {
    await call('roblox_edit', { source: `local root=workspace:FindFirstChild(${JSON.stringify(marker)}); if root and root:GetAttribute("RobloxAgentV4Disposable") == true then root:Destroy(); return true end; return false` }, true).catch(() => undefined);
  }
  await client.close().catch(() => undefined);
  await rm(runtimeDir, { recursive: true, force: true });
}
