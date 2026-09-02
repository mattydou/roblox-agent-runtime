import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChrrxsClient } from '../src/chrrxs/client.js';
import { parseExecuteResult } from '../src/runtime/luau.js';
import { Telemetry } from '../src/runtime/telemetry.js';

if (process.env.ROBLOX_AGENT_LIVE_ANIMATION_MATRIX !== '1') {
  console.log('SKIP: set ROBLOX_AGENT_LIVE_ANIMATION_MATRIX=1 to opt in to the animation registration context matrix.');
  process.exit(0);
}

const suffix = randomUUID().slice(0, 8);
const folderName = `__RobloxAgentMatrix_${suffix}`;
const artifactPath = `game.ReplicatedStorage.${folderName}.Sequence`;
const runtimeDir = path.join(os.tmpdir(), `roblox-agent-animation-matrix-${suffix}`);
const telemetry = new Telemetry(runtimeDir);
const chrrxs = new ChrrxsClient({ cwd: process.cwd(), taskId: async () => null, telemetry });
let solo = false;

const makeArtifact = `
local folder = Instance.new("Folder") folder.Name = ${JSON.stringify(folderName)} folder.Parent = game:GetService("ReplicatedStorage")
folder:SetAttribute("RobloxAgentManagedAnimationMatrix", true)
local sequence = Instance.new("KeyframeSequence") sequence.Name = "Sequence" sequence.Parent = folder
local first = Instance.new("Keyframe") first.Time = 0 sequence:AddKeyframe(first)
local second = Instance.new("Keyframe") second.Time = 0.1 sequence:AddKeyframe(second)
return game:GetService("HttpService"):JSONEncode({success=true, artifact=${JSON.stringify(artifactPath)}})
`;

const methods = [
  ['AnimationClipProvider', 'RegisterActiveAnimationClip'],
  ['AnimationClipProvider', 'RegisterAnimationClip'],
  ['KeyframeSequenceProvider', 'RegisterActiveKeyframeSequence'],
  ['KeyframeSequenceProvider', 'RegisterKeyframeSequence'],
] as const;

function matrixCode(service: string, method: string): string {
  return `
local sequence = game:GetService("ReplicatedStorage"):FindFirstChild(${JSON.stringify(folderName)})
sequence = sequence and sequence:FindFirstChild("Sequence")
if not sequence then error("matrix sequence missing") end
local ok, value = pcall(function() return game:GetService(${JSON.stringify(service)})[${JSON.stringify(method)}](game:GetService(${JSON.stringify(service)}), sequence) end)
local result = {success=ok, service=${JSON.stringify(service)}, method=${JSON.stringify(method)}}
if ok then result.value = tostring(value) else result.error = string.sub(tostring(value),1,1000) end
return game:GetService("HttpService"):JSONEncode(result)
`;
}

async function run(context: string, tool: string, args: Record<string, unknown>) {
  for (const [service, method] of methods) {
    try {
      const raw = await chrrxs.callJson(tool, { ...args, code: matrixCode(service, method) }, 60_000);
      console.log(JSON.stringify({ context, ...parseExecuteResult(raw) as Record<string, unknown> }));
    } catch (error) {
      console.log(JSON.stringify({ context, service, method, success: false, transport_error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

try {
  await chrrxs.start();
  parseExecuteResult(await chrrxs.callJson('execute_luau', { code: makeArtifact, target: 'edit' }, 60_000));
  await run('edit_without_solo', 'execute_luau', { target: 'edit' });
  await chrrxs.callJson('solo_playtest', { action: 'start', mode: 'play' }, 180_000);
  solo = true;
  await run('edit_while_solo', 'execute_luau', { target: 'edit' });
  await run('server_runtime', 'eval_server_runtime', {});
  await run('client_runtime', 'eval_client_runtime', { target: 'client-1' });
} finally {
  if (solo) await chrrxs.callJson('solo_playtest', { action: 'stop' }, 180_000).catch(() => undefined);
  await chrrxs.callJson('execute_luau', { target: 'edit', code: `
local folder = game:GetService("ReplicatedStorage"):FindFirstChild(${JSON.stringify(folderName)})
if folder and folder:GetAttribute("RobloxAgentManagedAnimationMatrix") == true then folder:Destroy() end
return game:GetService("HttpService"):JSONEncode({success=true, cleaned=folder ~= nil})
` }, 60_000).catch(() => undefined);
  await chrrxs.close();
  await rm(runtimeDir, { recursive: true, force: true });
}
