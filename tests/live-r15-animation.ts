import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

if (process.env.ROBLOX_AGENT_LIVE_R15_TEST !== '1') {
  console.log('SKIP: set ROBLOX_AGENT_LIVE_R15_TEST=1 to opt in to the temporary R15 animation smoke test.');
  process.exit(0);
}

const suffix = randomUUID().slice(0, 8);
const runtimeDir = path.join(os.tmpdir(), `roblox-agent-r15-live-${suffix}`);
const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ROBLOX_AGENT_RUNTIME_DIR: runtimeDir };
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.resolve('dist/server.js')], cwd: process.cwd(), env,
  stderr: 'inherit', maxBufferSize: 32 * 1024 * 1024,
});
const client = new Client({ name: 'roblox-agent-r15-live-smoke', version: '0.1.0' }, { capabilities: {} });
const rigName = `__RobloxAgentR15_${suffix}`;
const animationName = `__RobloxAgentR15Wave_${suffix}`;
const artifactOnlyName = `${animationName}_ArtifactOnly`;
const cachedAnimationName = `${animationName}_Cached`;
let rigPath: string | undefined;

function textBody(result: CallToolResult): string {
  const block = result.content.find((item) => item.type === 'text');
  return block?.type === 'text' ? block.text : '';
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000, resetTimeoutOnProgress: true }) as CallToolResult;
  if (result.isError) throw new Error(`${name} failed: ${textBody(result)}`);
  return JSON.parse(textBody(result)) as Record<string, unknown>;
}

try {
  await client.connect(transport);
  const acquired = await call('roblox_author', {
    kind: 'animation', operation: 'acquire_fixture', fixture: { rig_type: 'R15', name: rigName, position: [0, 3, 0] },
  });
  if (acquired.success !== true || acquired.managed_fixture !== true || typeof acquired.target_rig !== 'string') {
    throw new Error(`failed to acquire public R15 fixture: ${JSON.stringify(acquired)}`);
  }
  rigPath = acquired.target_rig;
  console.log(`PASS acquired wrapper-managed native R15 fixture ${rigPath}`);

  const rig = acquired.rig as Record<string, unknown>;
  if (rig.rig_type !== 'R15') throw new Error(`expected R15 manifest, got ${JSON.stringify(rig.rig_type)}`);
  const animatedParts = rig.animated_parts as Array<{ name: string }>;
  const expectedParts = ['LowerTorso', 'UpperTorso', 'RightUpperArm', 'RightLowerArm', 'RightHand'];
  for (const name of expectedParts) if (!animatedParts.some((part) => part.name === name)) throw new Error(`R15 manifest omitted ${name}`);
  console.log(`PASS discovered native R15 hierarchy including ${expectedParts.join(', ')}`);

  const beforeArtifactOnly = await call('roblox_test', { mode: 'solo', action: 'status' });
  if (JSON.stringify(beforeArtifactOnly).includes('"running":true')) throw new Error('artifact-only precondition expected no running Solo playtest');
  const artifactOnly = await call('roblox_author', { kind: 'animation', operation: 'create', animation: {
    target_rig: rigPath, name: artifactOnlyName, preview: 'none', replace_existing: true,
    keyframes: [{ time: 0, poses: [{ joint: 'RightHand' }] }, { time: 0.2, poses: [{ joint: 'RightHand', rotation_degrees: [0, 0, 5] }] }],
  } });
  if (artifactOnly.success !== true || artifactOnly.preview_registered !== false || (artifactOnly.stages as Record<string, unknown>)?.registration === undefined) {
    throw new Error(`artifact-only R15 creation failed: ${JSON.stringify(artifactOnly)}`);
  }
  const afterArtifactOnly = await call('roblox_test', { mode: 'solo', action: 'status' });
  if (JSON.stringify(afterArtifactOnly).includes('"running":true')) throw new Error('artifact-only creation started a Solo playtest');
  console.log('PASS committed an artifact-only R15 KeyframeSequence without starting or registering a preview');

  const authored = await call('roblox_author', { kind: 'animation', operation: 'create', animation: {
    target_rig: rigPath, name: animationName, preview: 'play', replace_existing: true, priority: 'Action',
    keyframes: [
      { time: 0, poses: [{ joint: 'UpperTorso' }, { joint: 'RightUpperArm' }, { joint: 'RightLowerArm' }, { joint: 'RightHand' }] },
      { time: 0.35, poses: [
        { joint: 'UpperTorso', rotation_degrees: [0, -8, 0] }, { joint: 'RightUpperArm', rotation_degrees: [-35, 0, 20] },
        { joint: 'RightLowerArm', rotation_degrees: [-25, 0, 0] }, { joint: 'RightHand', rotation_degrees: [0, 0, 15] },
      ], markers: [{ name: 'Apex' }] },
      { time: 0.7, poses: [{ joint: 'UpperTorso' }, { joint: 'RightUpperArm' }, { joint: 'RightLowerArm' }, { joint: 'RightHand' }] },
    ],
  }, observation: { samples: [{ marker: 'Apex' }], continue_playback: false } });
  const previewPlay = authored.preview_play as Record<string, unknown>;
  if (authored.success !== true || previewPlay?.success !== true || authored.deployment_ready !== false || authored.preview_id_scope !== 'studio_session') {
    throw new Error(`R15 authoring/preview failed: ${JSON.stringify(authored)}`);
  }
  if (!authored.synchronized_observation) throw new Error('synchronized R15 observation metadata is missing');
  if ('rig_inspection' in authored || 'rig_manifest' in authored) throw new Error('normal authoring leaked the internal rig manifest');
  console.log('PASS authored, synchronized one visual frame, and cleaned up the native R15 preview track');

  const cached = await call('roblox_author', { kind: 'animation', operation: 'create', animation: {
    target_rig: rigPath, name: cachedAnimationName, preview: 'register', replace_existing: true,
    keyframes: [{ time: 0, poses: [{ joint: 'RightHand' }] }, { time: 0.2, poses: [{ joint: 'RightHand', rotation_degrees: [0, 0, -10] }] }],
  } });
  if ((cached.rig_validation as Record<string, unknown>)?.manifest_cache !== 'hit') throw new Error(`expected manifest cache hit: ${JSON.stringify(cached)}`);
  console.log('PASS reused the unchanged R15 rig manifest cache');
} finally {
  if (rigPath) {
    const cleanup = await call('roblox_author', {
      kind: 'animation', operation: 'cleanup_fixture', target_rig: rigPath, artifact_names: [artifactOnlyName, animationName, cachedAnimationName],
    });
    if (cleanup.success !== true) throw new Error(`R15 cleanup verification failed: ${JSON.stringify(cleanup)}`);
    console.log('PASS removed the wrapper-managed R15 fixture and animation artifacts');
  }
  await client.close().catch(() => undefined);
  await rm(runtimeDir, { recursive: true, force: true });
}
