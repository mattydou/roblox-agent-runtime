import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

if (process.env.ROBLOX_AGENT_LIVE_V3_TEST !== '1') {
  console.log('SKIP: set ROBLOX_AGENT_LIVE_V3_TEST=1 to opt in to bounded V3 Studio acceptance.');
  process.exit(0);
}

const suffix = randomUUID().slice(0, 8);
const runtimeDir = path.join(os.tmpdir(), `roblox-agent-v3-live-${suffix}`);
const names = { root: `__RobloxAgentV3_${suffix}`, fixture: `__RobloxAgentV3_R15_${suffix}`, gui: `__RobloxAgentV3_Gui_${suffix}`, tool: `__RobloxAgentV3_Tool_${suffix}`, script: `__RobloxAgentV3_Server_${suffix}` };
const rootPath = `game.Workspace.${names.root}`;
const env = { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string')), ROBLOX_AGENT_RUNTIME_DIR: runtimeDir };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/server.js')], cwd: process.cwd(), env, stderr: 'inherit', maxBufferSize: 48 * 1024 * 1024 });
const client = new Client({ name: 'roblox-agent-v3-live-acceptance', version: '0.5.0' }, { capabilities: {} });
let sessionId: string | undefined;
let fixturePath: string | undefined;
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

  await call('roblox_edit', { operations: [
    { op: 'create', id: 'root', class_name: 'Model', parent: 'game.Workspace', name: names.root },
    { op: 'create', id: 'distant', class_name: 'Part', parent: '$root', name: 'DistantTarget', properties: { Anchored: true, Position: { type: 'Vector3', x: 5000, y: 8, z: 5000 }, Size: { type: 'Vector3', x: 12, y: 12, z: 12 }, Color: { type: 'Color3RGB', r: 0, g: 255, b: 120 } } },
    { op: 'create', id: 'promptPart', class_name: 'Part', parent: '$root', name: 'PromptPart', properties: { Anchored: true, Size: { type: 'Vector3', x: 3, y: 3, z: 3 } } },
    { op: 'create', class_name: 'ProximityPrompt', parent: '$promptPart', name: 'Prompt', properties: { ActionText: 'Smoke', HoldDuration: 0, MaxActivationDistance: 15 } },
    { op: 'create', id: 'clickPart', class_name: 'Part', parent: '$root', name: 'ClickPart', properties: { Anchored: true, Size: { type: 'Vector3', x: 4, y: 4, z: 2 } } },
    { op: 'create', class_name: 'ClickDetector', parent: '$clickPart', name: 'Click', properties: { MaxActivationDistance: 20 } },
    { op: 'create', id: 'gui', class_name: 'ScreenGui', parent: 'game.StarterGui', name: names.gui, properties: { ResetOnSpawn: false } },
    { op: 'create', class_name: 'TextButton', parent: '$gui', name: 'SmokeButton', properties: { Text: 'V3 Smoke', Active: true, Interactable: true, Position: { type: 'UDim2', x: [0.5, -80], y: [0.5, -30] }, Size: { type: 'UDim2', x: [0, 160], y: [0, 60] } } },
    { op: 'create', class_name: 'Tool', parent: 'game.ServerStorage', name: names.tool, properties: { RequiresHandle: false, CanBeDropped: false } },
    { op: 'create', class_name: 'Script', parent: 'game.ServerScriptService', name: names.script, source: `game:GetService("Players").PlayerAdded:Connect(function(player) task.delay(1, function() local tool=game.ServerStorage:FindFirstChild(${JSON.stringify(names.tool)}); local backpack=player:FindFirstChildOfClass("Backpack"); if tool and backpack then tool:Clone().Parent=backpack end end) end)` },
  ] });
  created = true;

  const beforeCamera = await call('roblox_observe', { mode: 'state', context: 'edit', path: 'game.Workspace.Camera', properties: ['CameraType', 'CFrame', 'Focus', 'FieldOfView'] });
  const captured = await raw('roblox_observe', { mode: 'views', context: 'edit', target_path: `${rootPath}.DistantTarget`, views: [{ preset: 'front' }, { preset: 'rear' }, { preset: 'left' }, { preset: 'overhead' }, { preset: 'front_right' }] });
  const captureManifest = body(captured);
  if (captureManifest.success !== true || captured.content.filter((item) => item.type === 'image').length !== 5) throw new Error(`five-view edit capture failed: ${JSON.stringify(captureManifest)}`);
  const afterCamera = await call('roblox_observe', { mode: 'state', context: 'edit', path: 'game.Workspace.Camera', properties: ['CameraType', 'CFrame', 'Focus', 'FieldOfView'] });
  if (JSON.stringify(beforeCamera) !== JSON.stringify(afterCamera)) throw new Error('controlled edit capture did not restore the original camera state');
  console.log('PASS five ordered distant edit views captured with viewport restoration and no playtest');

  const acquired = await call('roblox_author', { kind: 'fixture', operation: 'acquire', fixture: { rig_type: 'R15', name: names.fixture, position: [0, 3, 0] } });
  fixturePath = String(acquired.target_rig);
  const begun = await call('roblox_test', { mode: 'solo', action: 'begin_session', play_mode: 'play', required_roles: ['server', 'client-1'] });
  sessionId = String((begun.session as Record<string, unknown>).id);
  if ((begun.session as Record<string, unknown>).status !== 'ready' || !(begun.runtime_state as Record<string, unknown>)) throw new Error(`granular begin result missing: ${JSON.stringify(begun)}`);
  const readiness = await call('roblox_test', { mode: 'solo', action: 'run_batch', session_id: sessionId, batch: { actions: [
    { kind: 'wait_for', context: 'client-1', condition: 'character_ready', timeout_ms: 15_000 },
  ] } });
  if (readiness.success !== true) throw new Error(`Character readiness failed: ${JSON.stringify(readiness)}`);
  const current = await call('roblox_test', { mode: 'solo', action: 'session_status', session_id: sessionId });
  const liveState = current.runtime_state as Record<string, unknown>;
  if (liveState.player_available !== true || liveState.character_available !== true || typeof liveState.player_name !== 'string' || typeof liveState.character_path !== 'string') throw new Error(`session status did not expose a live Character after readiness: ${JSON.stringify(current)}`);
  const playerName = String(liveState.player_name);
  const characterPath = String(liveState.character_path);
  const setup = await call('roblox_test', { mode: 'solo', action: 'run_batch', session_id: sessionId, batch: { actions: [
    { kind: 'position', context: 'server', subject: { kind: 'path', path: fixturePath }, destination: { kind: 'character', player: playerName }, offset: [0, 0, -10], offset_space: 'anchor', orientation: { kind: 'face_path', path: characterPath } },
    { kind: 'position', context: 'server', subject: { kind: 'path', path: `${rootPath}.PromptPart` }, destination: { kind: 'character', player: playerName }, offset: [3, 0, -5], offset_space: 'anchor' },
    { kind: 'position', context: 'server', subject: { kind: 'path', path: `${rootPath}.ClickPart` }, destination: { kind: 'character', player: playerName }, offset: [0, 1, -7], offset_space: 'anchor' },
  ] } });
  if (setup.success !== true) throw new Error(`live-relative fixture setup failed: ${JSON.stringify(setup)}`);
  console.log('PASS R15 fixture positioned from the actual live Character pivot without selecting the player as subject');

  const tool = await call('roblox_test', { mode: 'solo', action: 'run_batch', session_id: sessionId, batch: { actions: [
    { kind: 'wait_for', context: 'client-1', condition: 'tool_available', tool: names.tool, timeout_ms: 15_000 },
    { kind: 'tool', context: 'client-1', operation: 'equip', target: names.tool },
    { kind: 'tool', context: 'client-1', operation: 'activate', target: names.tool, auto_equip: false },
    { kind: 'tool', context: 'client-1', operation: 'unequip', target: names.tool },
  ] } });
  if (tool.success !== true) throw new Error(`delayed verified Tool workflow failed: ${JSON.stringify(tool)}`);

  const gui = await call('roblox_inspect', { mode: 'gui', context: 'client-1', path: `game.Players.${playerName}.PlayerGui.${names.gui}`, depth: 3, max_results: 20 });
  if (!Array.isArray(gui.results)) throw new Error(`runtime GUI inspection failed: ${JSON.stringify(gui)}`);
  const interactions = await call('roblox_test', { mode: 'solo', action: 'run_batch', session_id: sessionId, batch: {
    watches: [
      { id: 'prompted', kind: 'signal', context: 'server', path: `${rootPath}.PromptPart.Prompt`, signal: 'Triggered' },
      { id: 'clicked', kind: 'signal', context: 'server', path: `${rootPath}.ClickPart.Click`, signal: 'MouseClick' },
      { id: 'guiActivated', kind: 'signal', context: 'client-1', path: `game.Players.${playerName}.PlayerGui.${names.gui}.SmokeButton`, signal: 'Activated' },
    ],
    actions: [
      { kind: 'interaction', interaction: 'proximity_prompt', path: `${rootPath}.PromptPart.Prompt`, timeout_ms: 10_000 },
      { kind: 'interaction', interaction: 'click_detector', path: `${rootPath}.ClickPart.Click`, timeout_ms: 10_000 },
      { kind: 'interaction', interaction: 'gui_button', path: `game.Players.${playerName}.PlayerGui.${names.gui}.SmokeButton`, timeout_ms: 10_000 },
    ],
    assertions: [
      { id: 'promptObserved', evidence: 'prompted', condition: 'at_least_one_occurrence' },
      { id: 'clickObserved', evidence: 'clicked', condition: 'at_least_one_occurrence' },
      { id: 'guiObserved', evidence: 'guiActivated', condition: 'at_least_one_occurrence' },
    ],
  } });
  if (interactions.success !== true) throw new Error(`generic interaction evidence failed: ${JSON.stringify(interactions)}`);
  console.log('PASS Tool, Prompt, ClickDetector, GuiButton, GUI inspection, and multi-watch evidence');

  await call('roblox_test', { mode: 'solo', action: 'finish_session', session_id: sessionId }); sessionId = undefined;
} catch (error) {
  if (!connectedStudio && !created) console.log(`UNVERIFIED: compatible connected Studio/plugin unavailable (${error instanceof Error ? error.message : String(error)})`);
  else throw error;
} finally {
  if (sessionId) await call('roblox_test', { mode: 'solo', action: 'finish_session', session_id: sessionId }, true).catch(() => undefined);
  if (fixturePath) await call('roblox_author', { kind: 'fixture', operation: 'cleanup', target_rig: fixturePath }, true).catch(() => undefined);
  if (created) await call('roblox_edit', { operations: [
    { op: 'delete', target: `game.ServerScriptService.${names.script}` }, { op: 'delete', target: `game.ServerStorage.${names.tool}` },
    { op: 'delete', target: `game.StarterGui.${names.gui}` }, { op: 'delete', target: rootPath },
  ], continue_on_error: true }, true).catch(() => undefined);
  await client.close().catch(() => undefined);
  await rm(runtimeDir, { recursive: true, force: true });
}
