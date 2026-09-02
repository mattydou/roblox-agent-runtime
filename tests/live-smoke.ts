import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.ROBLOX_AGENT_LIVE_TEST !== '1') {
  console.log('SKIP: set ROBLOX_AGENT_LIVE_TEST=1 to opt in to the live Studio smoke test.');
  process.exit(0);
}

const suffix = randomUUID().slice(0, 8);
const runtimeDir = path.join(os.tmpdir(), `roblox-agent-live-${suffix}`);
const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ROBLOX_AGENT_RUNTIME_DIR: runtimeDir };
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/server.js')],
  cwd: process.cwd(),
  env,
  stderr: 'inherit',
  maxBufferSize: 32 * 1024 * 1024,
});
const client = new Client({ name: 'roblox-agent-live-smoke', version: '0.1.0' }, { capabilities: {} });
const rootName = `__RobloxAgentSmoke_${suffix}`;
const rootPath = `game.Workspace.${rootName}`;
let playtestStarted = false;
let treeCreated = false;

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000, resetTimeoutOnProgress: true });
  const text = result.content.find((block) => block.type === 'text');
  const body = text?.type === 'text' ? text.text : '';
  if (result.isError) throw new Error(`${name}: ${body}`);
  try { return JSON.parse(body); } catch { return body; }
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 6) throw new Error(`expected six public tools, got ${tools.tools.length}`);

  const status = await call('roblox_inspect', { mode: 'status' });
  if (!JSON.stringify(status).includes('edit')) throw new Error('no connected Studio edit peer found');
  console.log('PASS wrapper reached Chrrxs and inspected Studio');

  await call('roblox_edit', { operations: [
    { op: 'create', id: 'root', class_name: 'Folder', parent: 'game.Workspace', name: rootName },
    { op: 'create', id: 'part', class_name: 'Part', parent: '$root', name: 'Part', properties: {
      Anchored: true,
      Size: { type: 'Vector3', x: 2, y: 1, z: 2 },
      Position: { type: 'Vector3', x: 0, y: 5, z: 0 },
    } },
    { op: 'modify', target: '$part', properties: { Transparency: 0.25 } },
  ] });
  treeCreated = true;
  const properties = await call('roblox_inspect', { mode: 'properties', path: `${rootPath}.Part` });
  if (!JSON.stringify(properties).includes('0.25')) throw new Error('temporary Part modification was not observed');
  console.log('PASS wrapper created, modified, and inspected a harmless temporary tree');

  const rig = process.env.ROBLOX_AGENT_LIVE_RIG;
  if (rig) {
    const inspection = await call('roblox_author', { kind: 'animation', operation: 'inspect_rig', target_rig: rig }) as {
      rig?: { animated_parts?: Array<{ name: string; path: string; depth: number }> };
    };
    const animatedParts = inspection.rig?.animated_parts ?? [];
    const requested = process.env.ROBLOX_AGENT_LIVE_JOINT;
    const target = requested
      ? animatedParts.find((part) => part.name === requested || part.path === requested)
      : animatedParts.find((part) => part.depth > 0);
    if (!target) throw new Error(`live rig inspection did not expose requested animated target ${requested ?? '<first non-root>'}`);
    const authored = await call('roblox_author', { kind: 'animation', animation: {
      target_rig: rig,
      name: `__RobloxAgentSmokeAnimation_${suffix}`,
      preview: 'play',
      replace_existing: true,
      keyframes: [
        { time: 0, poses: [{ joint: target.path }] },
        { time: 0.25, poses: [{ joint: target.path, rotation_degrees: [0, 0, 15] }] },
      ],
    } });
    if (!JSON.stringify(authored).includes('preview_id')) throw new Error('animation preview id was not returned');
    console.log('PASS wrapper authored and requested playback of a native KeyframeSequence');
  } else {
    console.log('SKIP animation: set ROBLOX_AGENT_LIVE_RIG to inspect and animate a supplied authoritative rig');
  }

  const screenshot = await client.callTool({ name: 'roblox_observe', arguments: { mode: 'screenshot', format: 'jpeg', quality: 80 } }, undefined, { timeout: 180_000 });
  if (screenshot.isError || !screenshot.content.some((block) => block.type === 'image')) throw new Error('viewport screenshot did not return MCP image content');
  console.log('PASS wrapper captured an MCP image screenshot');

  await call('roblox_test', { mode: 'solo', action: 'start', collect_logs: true });
  playtestStarted = true;
  await call('roblox_test', { mode: 'solo', action: 'status', collect_logs: true });
  await call('roblox_test', { mode: 'solo', action: 'stop', collect_logs: true });
  playtestStarted = false;
  console.log('PASS wrapper started, inspected, and stopped a solo playtest');
} finally {
  if (playtestStarted) await call('roblox_test', { mode: 'solo', action: 'stop', collect_logs: false }).catch(() => undefined);
  if (treeCreated) await call('roblox_edit', { operations: [{ op: 'delete', target: rootPath }] }).catch(() => undefined);
  await client.close().catch(() => undefined);
  await rm(runtimeDir, { recursive: true, force: true });
}
