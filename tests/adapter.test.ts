import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ChrrxsAdapter } from '../src/chrrxs/adapter.js';
import { extractJsonToolResult } from '../src/chrrxs/client.js';
import { RobloxAgentRuntime } from '../src/runtime/app.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { clearAuthorRigManifestCache } from '../src/tools/author.js';

class MockChrrxs implements ChrrxsAdapter {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  async start() {}
  async close() {}
  async listTools() { return []; }
  startRuntimeLogSession() {}
  updateRuntimeLogSession() {}
  endRuntimeLogSession() {}
  async collectRuntimeLogs() { return { entries: [], captures: [], capture_errors: {}, partial: false }; }
  async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    this.calls.push({ name, args });
    return {
      content: [{ type: 'text', text: 'Screenshot 1x1px' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }],
      structuredContent: { width: 1, height: 1, nativeWidth: 2, nativeHeight: 2, coordinateScale: 2 },
    };
  }
  async callJson(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'execute_luau') return { success: true, returnValue: JSON.stringify({ success: true, requested: 1, attempted: 1, results: [{ success: true }] }) };
    return { success: true, name };
  }
}

class RigAuthorMock extends MockChrrxs {
  failStaleOnce = false;

  override async callJson(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ name, args });
    const code = String(args.code ?? '');
    if (!code.includes('Instance.new("KeyframeSequence")')) {
      return { success: true, returnValue: JSON.stringify({
        target_rig: 'game.Workspace.R15Rig',
        fingerprint: '1234abcd',
        rig_type: 'R15',
        controller_class: 'Humanoid',
        controller_path: 'game.Workspace.R15Rig.Humanoid',
        roots: ['game.Workspace.R15Rig.HumanoidRootPart'],
        animated_parts: [
          {
            name: 'HumanoidRootPart', path: 'game.Workspace.R15Rig.HumanoidRootPart', relative_path: 'HumanoidRootPart',
            depth: 0, aliases: ['HumanoidRootPart', 'game.Workspace.R15Rig.HumanoidRootPart'],
          },
          {
            name: 'RightHand', path: 'game.Workspace.R15Rig.RightHand', relative_path: 'RightHand',
            parent_path: 'game.Workspace.R15Rig.RightLowerArm', via_joint_name: 'RightWrist',
            via_joint_path: 'game.Workspace.R15Rig.RightLowerArm.RightWrist', via_joint_class: 'Motor6D', depth: 1,
            aliases: ['RightHand', 'RightWrist', 'game.Workspace.R15Rig.RightHand'],
          },
        ],
        joints: [{
          name: 'RightWrist', class_name: 'Motor6D', path: 'game.Workspace.R15Rig.RightLowerArm.RightWrist',
          relative_path: 'RightLowerArm.RightWrist', part0_path: 'game.Workspace.R15Rig.RightLowerArm',
          part1_path: 'game.Workspace.R15Rig.RightHand', animated_part_path: 'game.Workspace.R15Rig.RightHand', animatable: true,
        }],
      }) };
    }
    if (this.failStaleOnce) {
      this.failStaleOnce = false;
      throw new Error('RIG_MANIFEST_STALE: authoritative target rig animation hierarchy changed');
    }
    return { success: true, returnValue: JSON.stringify({
      success: true,
      artifact_path: 'game.ServerStorage.RobloxAgentArtifacts.Animations.Wave',
      preview_animation_path: 'game.ServerStorage.RobloxAgentArtifacts.Animations.Wave_Preview',
      preview_id: 'active://wave',
      preview_play: { requested: true, success: true },
    }) };
  }
}

describe('mocked Chrrxs adapter routing', () => {
  it('maps one model edit call to one internal execute_luau batch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-adapter-'));
    const mock = new MockChrrxs();
    const runtime = new RobloxAgentRuntime(mock, new Telemetry(root), root);
    const result = await runtime.dispatch('roblox_edit', { operations: [{ op: 'delete', target: 'game.Workspace.Temp' }] });
    expect(result.isError).not.toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.name).toBe('execute_luau');
  });

  it('preserves screenshot image content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-adapter-'));
    const runtime = new RobloxAgentRuntime(new MockChrrxs(), new Telemetry(root), root);
    const result = await runtime.dispatch('roblox_observe', { mode: 'screenshot' });
    expect(result.content.some((block) => block.type === 'image')).toBe(true);
    expect((result as CallToolResult).structuredContent).toEqual({
      width: 1, height: 1, nativeWidth: 2, nativeHeight: 2, coordinateScale: 2,
    });
  });

  it('maps v2 content search and selection semantics to their v3 tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-adapter-'));
    const mock = new MockChrrxs();
    const runtime = new RobloxAgentRuntime(mock, new Telemetry(root), root);

    await runtime.dispatch('roblox_inspect', {
      mode: 'search', query: 'RemoteEvent', search_by: 'content', max_results: 12,
    });
    await runtime.dispatch('roblox_inspect', { mode: 'selection' });

    expect(mock.calls).toEqual([
      { name: 'grep_scripts', args: { pattern: 'RemoteEvent', maxResults: 12 } },
      { name: 'selection', args: { action: 'get' } },
    ]);
  });

  it('prefers v3 structuredContent and retains legacy JSON-text fallback', () => {
    const structured = { success: true, source: 'structured' };
    expect(extractJsonToolResult({
      content: [{ type: 'text', text: JSON.stringify({ source: 'legacy' }) }],
      structuredContent: structured,
    })).toEqual(structured);
    expect(extractJsonToolResult({
      content: [{ type: 'text', text: JSON.stringify({ success: true, source: 'legacy' }) }],
    })).toEqual({ success: true, source: 'legacy' });
  });

  it('inspects the authoritative R15 rig before authoring with a canonical target', async () => {
    clearAuthorRigManifestCache();
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-adapter-'));
    const mock = new RigAuthorMock();
    const runtime = new RobloxAgentRuntime(mock, new Telemetry(root), root);
    const result = await runtime.dispatch('roblox_author', {
      kind: 'animation',
      operation: 'create',
      animation: {
        target_rig: 'game.Workspace.R15Rig', name: 'Wave', preview: 'play',
        keyframes: [
          { time: 0, poses: [{ joint: 'RightWrist' }] },
          { time: 0.25, poses: [{ joint: 'RightWrist', rotation_degrees: [0, 0, 20] }] },
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(mock.calls.map((call) => call.name)).toEqual(['execute_luau', 'execute_luau']);
    expect(String(mock.calls[1]!.args.code)).toContain('game.Workspace.R15Rig.RightHand');

    const second = await runtime.dispatch('roblox_author', {
      kind: 'animation', animation: {
        target_rig: 'game.Workspace.R15Rig', name: 'SecondWave', preview: 'play',
        keyframes: [
          { time: 0, poses: [{ joint: 'RightWrist' }] },
          { time: 0.25, poses: [{ joint: 'RightWrist', rotation_degrees: [0, 0, -20] }] },
        ],
      },
    });
    expect(mock.calls).toHaveLength(3);
    const secondBody = JSON.parse((second.content[0] as { type: 'text'; text: string }).text) as Record<string, unknown>;
    expect(secondBody).not.toHaveProperty('rig_inspection');
    expect(secondBody.rig_validation).toMatchObject({ manifest_cache: 'hit', rig_type: 'R15' });
  });

  it('invalidates and re-inspects once when Studio reports a stale rig fingerprint', async () => {
    clearAuthorRigManifestCache();
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-adapter-'));
    const mock = new RigAuthorMock();
    mock.failStaleOnce = true;
    const runtime = new RobloxAgentRuntime(mock, new Telemetry(root), root);
    const result = await runtime.dispatch('roblox_author', {
      kind: 'animation', animation: {
        target_rig: 'game.Workspace.R15Rig', name: 'RetryWave',
        keyframes: [
          { time: 0, poses: [{ joint: 'RightHand' }] },
          { time: 0.2, poses: [{ joint: 'RightHand', rotation_degrees: [5, 0, 0] }] },
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(mock.calls).toHaveLength(4);
    const body = JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as Record<string, unknown>;
    expect(body.rig_validation).toMatchObject({ manifest_cache: 'refreshed' });
  });
});
