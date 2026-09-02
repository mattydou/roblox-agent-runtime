import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ChrrxsAdapter, RuntimeLogCollectionOptions } from '../src/chrrxs/adapter.js';
import { compileCameraOperation } from '../src/runtime/camera-luau.js';
import { compileEvidenceHarness } from '../src/runtime/evidence-luau.js';
import { compileGuiInspection } from '../src/runtime/luau.js';
import { ManagedRuntime } from '../src/runtime/managed-runtime.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { VIEW_PRESETS, ViewportController } from '../src/runtime/viewport-controller.js';
import { authorInputSchema, evidenceBatchSchema, inspectInputSchema, observeInputSchema } from '../src/tools/schemas.js';

class V3Mock implements ChrrxsAdapter {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  running = false;
  screenshotCount = 0;
  failScreenshot = 0;
  failRestore = false;
  failClientHarness = false;
  roles = ['edit'];
  async start() {} async close() {} async listTools() { return []; }
  startRuntimeLogSession() {} updateRuntimeLogSession() {} endRuntimeLogSession() {}
  async collectRuntimeLogs(_options: RuntimeLogCollectionOptions) { return { entries: [], captures: [], capture_errors: {}, partial: false }; }
  async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    this.calls.push({ name, args });
    this.screenshotCount += 1;
    if (this.failScreenshot === this.screenshotCount) throw new Error('isolated semantic capture failure');
    return { content: [{ type: 'text', text: JSON.stringify({ width: 640, height: 480, format: args.format, quality: args.quality }) }, { type: 'image', data: 'AA==', mimeType: 'image/jpeg' }] };
  }
  async callJson(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'get_connected_instances') return { instances: [{ roles: this.roles }] };
    if (name === 'solo_playtest') {
      if (args.action === 'status') return { running: this.running, roles: this.running ? ['server', 'client-1'] : [] };
      if (args.action === 'start') { this.running = true; return { running: true, roles: ['server', 'client-1'] }; }
      if (args.action === 'stop') { this.running = false; return { running: false }; }
    }
    if (name === 'simulate_mouse_input') return { success: true };
    if (name === 'execute_luau' || name === 'eval_server_runtime' || name === 'eval_client_runtime') {
      const code = String(args.code);
      if (this.failClientHarness && name === 'eval_client_runtime' && (code.includes('"operation":"begin"') || code.includes('"operation":"health"'))) throw new Error('client harness unavailable');
      let value: Record<string, unknown> = { success: true };
      if (code.includes('"operation":"snapshot"') && code.includes('field_of_view')) value = { success: true, snapshot: { camera_type: 'Custom', cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], focus: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], field_of_view: 70 }, target: { path: 'game.Workspace.Target', center: [0, 0, 0], bounds_size: [4, 4, 4], basis_components: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], radius: 10 } };
      else if (code.includes('"operation":"apply"')) value = { success: true, settled_frames: 2, camera: { position: [0, 0, -10], direction: [0, 0, 1], field_of_view: 70 } };
      else if (code.includes('"operation":"restore"')) { if (this.failRestore) throw new Error('restore transport unavailable'); value = { success: true, restored: true }; }
      else if (code.includes('"operation":"snapshot"')) value = { success: true, role: name.includes('client') ? 'client-1' : 'server', state: { player_available: true, player_name: 'Tester', character_available: false, humanoid_available: false, root_available: false, backpack_available: false, tools: [], equipped_tools: [] } };
      else if (code.includes('"operation":"health"')) value = { success: true, harness: 'healthy' };
      else if (code.includes('"operation":"wait_for"')) value = { success: true, condition: 'character_available', elapsed_ms: 250, observed: { character_available: true } };
      else if (code.includes('"operation":"position"')) value = { success: true, subject_path: 'game.Workspace.Fixture', anchor_path: 'game.Workspace.Character', requested_offset: [0, 0, -8], actual_position: [0, 3, -8], distance: 0 };
      else if (code.includes('"operation":"interaction"')) value = { success: true, dispatch: 'mouse', path: 'game.Players.Tester.PlayerGui.Screen.Button', x: 120, y: 80, button: 'Left' };
      else if (code.includes('"operation":"collect"')) value = { success: true, watches: [], series: [] };
      else if (code.includes('"operation":"probe"')) value = { success: true, probes: code.includes('serverOnly') ? [{ id: 'serverOnly', kind: 'exists', context: 'server', path: 'game.Workspace', exists: true }] : [] };
      return { success: true, returnValue: JSON.stringify(value) };
    }
    return { success: true };
  }
}

describe('V3 controlled observation', () => {
  it('publishes deterministic preset angles and fixed camera Luau', () => {
    expect(VIEW_PRESETS).toMatchObject({ front: { azimuth: 0, elevation: 0 }, rear: { azimuth: 180 }, overhead: { elevation: 89.5 }, front_right: { azimuth: 45, elevation: 25 } });
    const source = compileCameraOperation({ operation: 'snapshot', target_path: 'game.Workspace.Target', padding: 1, field_of_view: 70 });
    expect(source).not.toContain('ZoomToExtents');
    expect(source).toContain('RenderStepped');
    expect(source).not.toContain('loadstring');
  });

  it('captures ordered images and restores after success without lifecycle calls', async () => {
    const mock = new V3Mock();
    const controller = new ViewportController(mock);
    const input = observeInputSchema.parse({ mode: 'views', target_path: 'game.Workspace.Target', views: [{ preset: 'front' }, { preset: 'rear' }, { id: 'high', azimuth: 45, elevation: 25 }] });
    if (input.mode !== 'views') throw new Error('unexpected schema branch');
    const result = await controller.capture(input);
    const manifest = JSON.parse((result.content[0] as { text: string }).text);
    expect(manifest).toMatchObject({ success: true, restore: { requested: true, attempted: true, success: true } });
    expect(manifest.captures.map((item: Record<string, unknown>) => [item.view_id, item.image_index])).toEqual([['front', 1], ['rear', 2], ['high', 3]]);
    expect(result.content.filter((item) => item.type === 'image')).toHaveLength(3);
    expect(mock.calls.some((item) => item.name === 'solo_playtest')).toBe(false);
  });

  it('retains partial images, continues isolated capture failures, and still restores', async () => {
    const mock = new V3Mock(); mock.failScreenshot = 2;
    const controller = new ViewportController(mock);
    const input = observeInputSchema.parse({ mode: 'views', target_path: 'game.Workspace.Target', views: [{ preset: 'front' }, { preset: 'rear' }, { preset: 'left' }] });
    if (input.mode !== 'views') throw new Error('unexpected schema branch');
    const result = await controller.capture(input);
    const manifest = JSON.parse((result.content[0] as { text: string }).text);
    expect(result.isError).toBe(true);
    expect(manifest.captures.map((item: Record<string, unknown>) => item.success)).toEqual([true, false, true]);
    expect(manifest.captures[2].image_index).toBe(2);
    expect(manifest.restore).toMatchObject({ attempted: true, success: true });
  });

  it('fails closed before moving the edit camera when client auto-routing is active', async () => {
    const mock = new V3Mock(); mock.roles = ['edit', 'server', 'client-1'];
    const controller = new ViewportController(mock);
    const input = observeInputSchema.parse({ mode: 'views', context: 'edit', target_path: 'game.Workspace.Target', views: [{ preset: 'front' }] });
    if (input.mode !== 'views') throw new Error('unexpected schema branch');
    const result = await controller.capture(input);
    const manifest = JSON.parse((result.content[0] as { text: string }).text);
    expect(manifest.error_code).toBe('EDIT_CAPTURE_UNAVAILABLE_DURING_PLAYTEST');
    expect(mock.calls.map((item) => item.name)).toEqual(['get_connected_instances']);
  });

  it('classifies restoration failure as an unsuccessful cleanup failure', async () => {
    const mock = new V3Mock(); mock.failRestore = true;
    const controller = new ViewportController(mock);
    const input = observeInputSchema.parse({ mode: 'views', target_path: 'game.Workspace.Target', views: [{ preset: 'front' }] });
    if (input.mode !== 'views') throw new Error('unexpected schema branch');
    const result = await controller.capture(input);
    const manifest = JSON.parse((result.content[0] as { text: string }).text);
    expect(manifest).toMatchObject({ success: false, error_code: 'CAMERA_RESTORE_FAILED', restore: { attempted: true, success: false }, failure: { category: 'cleanup', stage: 'camera restore' } });
  });

  it('best-effort restores an in-flight controlled camera on controller shutdown', async () => {
    let releaseCapture!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    class BlockingMock extends V3Mock {
      override async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
        this.calls.push({ name, args }); await gate;
        return { content: [{ type: 'text', text: '{"width":640,"height":480}' }, { type: 'image', data: 'AA==', mimeType: 'image/jpeg' }] };
      }
    }
    const mock = new BlockingMock(); const controller = new ViewportController(mock);
    const input = observeInputSchema.parse({ mode: 'views', target_path: 'game.Workspace.Target', views: [{ preset: 'front' }] });
    if (input.mode !== 'views') throw new Error('unexpected schema branch');
    const pending = controller.capture(input);
    for (let spin = 0; spin < 20 && !mock.calls.some((item) => item.name === 'capture_screenshot'); spin += 1) await Promise.resolve();
    await controller.close();
    expect(mock.calls.filter((item) => item.name === 'execute_luau' && String(item.args.code).includes('"operation":"restore"')).length).toBeGreaterThanOrEqual(1);
    releaseCapture(); await pending;
  });
});

describe('V3 schemas and fixed GUI inspection', () => {
  it('validates target/center, bounded views, PNG, client and custom-angle contracts', () => {
    expect(observeInputSchema.safeParse({ mode: 'views', views: [{ preset: 'front' }] }).success).toBe(false);
    expect(observeInputSchema.safeParse({ mode: 'views', center: [0, 0, 0], basis: 'world', views: [{ preset: 'front' }] }).success).toBe(false);
    expect(observeInputSchema.safeParse({ mode: 'views', center: [0, 0, 0], radius: 10, basis: 'world', views: [{ azimuth: 10, elevation: 20 }] }).success).toBe(true);
    expect(observeInputSchema.safeParse({ mode: 'views', context: 'client-2', target_path: 'game.Workspace.X', views: [{ preset: 'front' }] }).success).toBe(false);
    expect(observeInputSchema.safeParse({ mode: 'views', target_path: 'game.Workspace.X', format: 'png', views: [{ preset: 'front' }, { preset: 'rear' }, { preset: 'left' }] }).success).toBe(false);
    expect(observeInputSchema.safeParse({ mode: 'views', target_path: 'game.Workspace.X', views: Array.from({ length: 7 }, () => ({ preset: 'front' })) }).success).toBe(false);
  });

  it('routes generic fixture forms to the same strict author contract', () => {
    expect(authorInputSchema.safeParse({ kind: 'fixture', operation: 'acquire', fixture: { rig_type: 'R6' } }).success).toBe(true);
    expect(authorInputSchema.safeParse({ kind: 'fixture', operation: 'cleanup', target_rig: 'game.Workspace.R15' }).success).toBe(true);
    expect(authorInputSchema.safeParse({ kind: 'fixture', operation: 'cleanup', target_rig: 'game.Workspace.R15', force: true }).success).toBe(false);
  });

  it('compiles bounded GUI facts without caller source or arbitrary properties', () => {
    expect(inspectInputSchema.safeParse({ mode: 'gui', context: 'client-1', path: 'game.Players.Tester.PlayerGui', depth: 4, max_results: 50 }).success).toBe(true);
    expect(inspectInputSchema.safeParse({ mode: 'gui', context: 'client-2', path: 'game.Players.Tester.PlayerGui' }).success).toBe(false);
    const source = compileGuiInspection({ path: 'game.StarterGui', depth: 3, max_results: 20, interactive_only: false, static_context: true });
    expect(source).toContain('effective_visible').toContain('AbsolutePosition').toContain('viewport_intersects');
    expect(source).not.toContain('loadstring');
  });
});

describe('V3 readiness and generic actions', () => {
  it('keeps session readiness separate from Character readiness and reuses a healthy session', async () => {
    const mock = new V3Mock();
    const root = await mkdtemp(path.join(os.tmpdir(), 'v3-ready-'));
    const runtime = new ManagedRuntime(mock, new Telemetry(root), { now: () => 0, sleep: async () => {} });
    const begun = await runtime.begin({ play_mode: 'play', required_roles: ['server', 'client-1'] });
    expect(begun).toMatchObject({ success: true, session: { status: 'ready', required_roles: ['server', 'client-1'] }, runtime_state: { player_available: true, character_available: false, backpack_available: false } });
    const reused = await runtime.begin({ play_mode: 'play', required_roles: ['server'] });
    expect(reused.lifecycle.transitions).toContain('existing_session_reused');
  });

  it('classifies a required role failure as infrastructure and self-cleans its owned playtest', async () => {
    const mock = new V3Mock(); mock.failClientHarness = true;
    const root = await mkdtemp(path.join(os.tmpdir(), 'v3-role-'));
    const runtime = new ManagedRuntime(mock, new Telemetry(root));
    const begun = await runtime.begin({ play_mode: 'play', required_roles: ['server', 'client-1'] });
    expect(begun).toMatchObject({ success: false, failure_kind: 'infrastructure', error_code: 'REQUIRED_HARNESS_ROLE_UNAVAILABLE', failure: { stage: 'harness installation/health', observed: { role_health: { 'client-1': { status: 'unavailable' } } } }, cleanup: { owned_playtest_stopped: true } });
    expect(mock.running).toBe(false);
  });

  it('runs wait, live-relative positioning, and bounds-derived GUI input in one batch', async () => {
    const mock = new V3Mock();
    const root = await mkdtemp(path.join(os.tmpdir(), 'v3-actions-'));
    let clock = 0;
    const runtime = new ManagedRuntime(mock, new Telemetry(root), { now: () => clock, sleep: async (ms) => { clock += ms; } });
    const begun = await runtime.begin({ play_mode: 'play' });
    const batch = evidenceBatchSchema.parse({ actions: [
      { id: 'ready', kind: 'wait_for', context: 'client-1', condition: 'character_available' },
      { id: 'placed', kind: 'position', context: 'server', subject: { kind: 'path', path: 'game.Workspace.Fixture' }, destination: { kind: 'character', player: 'Tester' }, offset: [0, 0, -8], orientation: { kind: 'face_path', path: 'game.Players.Tester.Character' } },
      { id: 'clicked', kind: 'interaction', interaction: 'gui_button', path: 'game.Players.Tester.PlayerGui.Screen.Button' },
    ] });
    const result = await runtime.runBatch(begun.session.id, batch);
    expect(result.report.actions.every((item) => item.success)).toBe(true);
    expect(result.report.actions[1]).toMatchObject({ details: { subject_path: 'game.Workspace.Fixture', distance: 0 } });
    expect(result.report.actions[2]).toMatchObject({ details: { input_dispatched: true, x: 120, y: 80 } });
    expect(mock.calls.find((item) => item.name === 'simulate_mouse_input')?.args).toMatchObject({ action: 'click', target: 'client-1', x: 120, y: 80 });
  });

  it('allows server evidence before Character availability and enforces the total batch deadline', async () => {
    const mock = new V3Mock();
    const root = await mkdtemp(path.join(os.tmpdir(), 'v3-deadline-'));
    let clock = 0;
    const runtime = new ManagedRuntime(mock, new Telemetry(root), { now: () => clock, sleep: async (ms) => { clock += ms; } });
    const begun = await runtime.begin({ play_mode: 'play' });
    expect(begun.runtime_state).toMatchObject({ character_available: false });
    const server = await runtime.runBatch(begun.session.id, evidenceBatchSchema.parse({ checkpoints: [{ id: 'serverCheckpoint', probes: [{ id: 'serverOnly', kind: 'exists', context: 'server', path: 'game.Workspace' }] }] }));
    expect(server.report).toMatchObject({ success: true, observations: [{ probes: [{ id: 'serverOnly', exists: true }] }] });
    const deadline = await runtime.runBatch(begun.session.id, evidenceBatchSchema.parse({ deadline_ms: 1_000, actions: [{ id: 'tooLong', kind: 'wait', duration_ms: 5_000 }] }));
    expect(deadline.report).toMatchObject({ success: false, error_code: 'BATCH_DEADLINE_EXCEEDED', failure: { category: 'readiness', stage: 'batch deadline', retryable: 'unknown' } });
    expect(clock).toBe(1_000);
  });

  it('keeps Tool and native interaction programs fixed and primitive-specific', () => {
    const tool = compileEvidenceHarness({ operation: 'tool', session_id: 's', role: 'client-1', tool_operation: 'activate', target: 'Sword', timeout_ms: 5_000, poll_interval_ms: 100 });
    const prompt = compileEvidenceHarness({ operation: 'interaction', session_id: 's', role: 'client-1', interaction: 'proximity_prompt', path: 'game.Workspace.Part.Prompt', timeout_ms: 5_000, poll_interval_ms: 100 });
    expect(tool).toContain('Humanoid').toContain('EquipTool').toContain('TOOL_NOT_EQUIPPED').not.toContain('firetouchinterest');
    expect(prompt).toContain('InputHoldBegin').toContain('InputHoldEnd').toContain('WorldToViewportPoint').toContain('AbsolutePosition');
    expect(prompt).not.toContain('fireproximityprompt');
    expect(prompt).not.toContain('fireclickdetector');
    expect(prompt).not.toContain('loadstring');
  });

  it('strictly validates action variants, explicit server players, and total deadlines', () => {
    expect(evidenceBatchSchema.safeParse({ actions: [{ kind: 'wait_for', context: 'server', condition: 'character_available' }] }).success).toBe(false);
    expect(evidenceBatchSchema.safeParse({ actions: [{ kind: 'interaction', interaction: 'gui_button', path: 'game.X', context: 'server' }] }).success).toBe(false);
    expect(evidenceBatchSchema.safeParse({ actions: [{ kind: 'tool', context: 'client-1', operation: 'activate', target: 'Sword', auto_equip: false }] }).success).toBe(true);
    expect(evidenceBatchSchema.safeParse({ deadline_ms: 60_001 }).success).toBe(false);
  });
});
