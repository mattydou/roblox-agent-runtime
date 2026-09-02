import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ChrrxsAdapter, RuntimeLogCollectionOptions } from '../src/chrrxs/adapter.js';
import { RobloxAgentRuntime } from '../src/runtime/app.js';
import { compileCallerLuau } from '../src/runtime/luau.js';
import { ManagedRuntime } from '../src/runtime/managed-runtime.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { evidenceBatchSchema } from '../src/tools/schemas.js';

class V4Mock implements ChrrxsAdapter {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  running = false;
  failEdit = false;
  failStatus = false;
  callerOwned = false;
  async start() {} async close() {} async listTools() { return []; }
  startRuntimeLogSession() {} updateRuntimeLogSession() {} endRuntimeLogSession() {}
  async collectRuntimeLogs(_options: RuntimeLogCollectionOptions) {
    return { entries: [{ level: 'info', message: 'v4 incremental log' }], captures: [], capture_errors: {}, partial: false };
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    this.calls.push({ name, args });
    return { content: [{ type: 'image', data: 'AA==', mimeType: 'image/jpeg' }] };
  }
  async callJson(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'execute_luau') {
      if (this.failEdit) throw new Error('edit completion unavailable');
      const code = String(args.code ?? '');
      if (code.includes('MAX_RESULT_BYTES')) return { success: true, returnValue: JSON.stringify({ success: true, value: { created: 8 } }) };
      return { success: true, returnValue: JSON.stringify({ success: true, requested: 1, attempted: 1, results: [{ success: true }] }) };
    }
    if (name === 'solo_playtest') {
      if (this.failStatus && args.action === 'status') throw new Error('plugin unavailable');
      if (args.action === 'status') return { running: this.running, roles: this.running ? ['server', 'client-1'] : [] };
      if (args.action === 'start') { this.running = true; return { running: true, roles: ['server', 'client-1'] }; }
      if (args.action === 'stop') { this.running = false; return { running: false }; }
    }
    if (name === 'simulate_keyboard_input' || name === 'simulate_mouse_input') return { success: true };
    if (name === 'eval_server_runtime' || name === 'eval_client_runtime') {
      const code = String(args.code ?? '');
      let value: Record<string, unknown> = { success: true };
      if (code.includes('SERVER_OK')) value = { success: true, value: 7 };
      else if (code.includes('CLIENT_OK')) value = { success: true, value: true };
      else if (code.includes('CLIENT_FAIL')) value = { success: false, error_code: 'CALLER_LUAU_FAILED', error: 'intentional failure' };
      else if (code.includes('"operation":"snapshot"')) value = { success: true, state: { player_available: true, character_available: true, backpack_available: true } };
      else if (code.includes('"operation":"health"')) value = { success: true, harness: 'healthy' };
      else if (code.includes('"operation":"probe"')) value = { success: true, probes: [{ id: 'exists', kind: 'exists', context: 'server', path: 'game.Workspace', exists: true }] };
      else if (code.includes('"operation":"collect"')) value = { success: true, watches: [{ id: 'changed', kind: 'property_change', context: 'server', initial_value: 0, final_value: 1, change_count: 1, occurrence_count: 1 }], series: [] };
      return { success: true, returnValue: JSON.stringify(value) };
    }
    return { success: true };
  }
}

async function runtimeWith(mock = new V4Mock()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-v4-'));
  return { root, mock, app: new RobloxAgentRuntime(mock, new Telemetry(root), root) };
}

describe('V4 bounded native Luau', () => {
  it('preserves structured edits and routes edit Luau once with bounded normalized results and task evidence', async () => {
    const { root, mock, app } = await runtimeWith();
    const legacy = await app.dispatch('roblox_edit', { operations: [{ op: 'modify', target: 'game.Workspace.Part', properties: { Anchored: true } }] });
    expect(legacy.isError).not.toBe(true);
    await app.dispatch('roblox_task', { action: 'begin', goal: 'V4 evidence' });
    const source = 'local PRIVATE_SOURCE = "never-in-telemetry"\nreturn {created = 8, secret = "PRIVATE_RESULT"}';
    const result = await app.dispatch('roblox_edit', { source, timeout_ms: 5_000 });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ success: true, value: { created: 8 }, execution_context: 'edit', retry_performed: false });
    const executeCalls = mock.calls.filter((call) => call.name === 'execute_luau');
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[1]?.args).toMatchObject({ target: 'edit' });
    expect(String(executeCalls[1]?.args.code)).toContain('MAX_RESULT_BYTES').toContain('never-in-telemetry');
    const task = await app.tasks.current();
    expect(task?.completed_operations.at(-1)).toMatchObject({ tool: 'roblox_edit', operation: 'luau', success: true });
    const telemetry = await readFile(path.join(root, 'logs', 'model-visible.jsonl'), 'utf8');
    expect(telemetry).not.toContain('never-in-telemetry').not.toContain('PRIVATE_RESULT');
  });

  it('never retries ambiguous edit code and conservatively stales an active session', async () => {
    const { mock, app } = await runtimeWith();
    const begun = await app.managedRuntime.begin({ play_mode: 'play' });
    mock.failEdit = true;
    const result = await app.dispatch('roblox_edit', { source: 'workspace:SetAttribute("MaybeChanged", true)' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ success: false, error_code: 'EDIT_LUAU_EXECUTION_AMBIGUOUS', partial_mutation_possible: true, retry_performed: false });
    expect(mock.calls.filter((call) => call.name === 'execute_luau')).toHaveLength(1);
    expect(app.managedRuntime.session(begun.session.id)?.status).toBe('stale');
  });

  it('wraps caller returns without an unrestricted peer selector', () => {
    const compiled = compileCallerLuau('return Vector3.new(1, 2, 3)');
    expect(compiled).toContain('MAX_RESULT_BYTES').toContain('xpcall').toContain('Vector3');
    expect(compiled).not.toContain('target =');
  });
});

describe('V4 managed one-shot runtime Luau', () => {
  it('mixes server/client code, watches, probes, assertions, screenshot, logs, and owned cleanup', async () => {
    const { mock, app } = await runtimeWith();
    const batch = evidenceBatchSchema.parse({
      watches: [{ id: 'changed', kind: 'property_change', context: 'server', path: 'game.Workspace', property: 'Name' }],
      actions: [
        { id: 'serverValue', kind: 'luau', role: 'server', source: 'return "SERVER_OK" and 7' },
        { id: 'clientValue', kind: 'luau', role: 'client-1', source: 'return "CLIENT_OK" and true' },
        { kind: 'screenshot', format: 'jpeg', quality: 80 },
      ],
      checkpoints: [{ id: 'after', probes: [{ id: 'exists', kind: 'exists', context: 'server', path: 'game.Workspace' }] }],
      assertions: [{ id: 'serverEquals', evidence: 'serverValue', condition: 'equals', expected: 7 }, { id: 'workspaceExists', evidence: 'exists', condition: 'exists' }],
    });
    const value = await app.managedRuntime.scenario({ play_mode: 'play', batch, required_roles: ['server', 'client-1'] });
    expect(value.report).toMatchObject({ success: true, cleanup: { owned_playtest_stopped: true }, runtime_errors: [], logs: { entries: [{ message: 'v4 incremental log' }] }, assertions: [{ passed: true }, { passed: true }] });
    expect(value.report.actions.slice(0, 2)).toMatchObject([{ kind: 'luau', role: 'server', value: 7 }, { kind: 'luau', role: 'client-1', value: true }]);
    expect(value.report.watches).toHaveLength(1);
    expect(value.report.observations).toHaveLength(1);
    expect(value.images).toHaveLength(1);
    expect(mock.running).toBe(false);
    expect(mock.calls.some((call) => call.name === 'eval_server_runtime' && String(call.args.code).includes('SERVER_OK'))).toBe(true);
    expect(mock.calls.some((call) => call.name === 'eval_client_runtime' && call.args.target === 'client-1' && String(call.args.code).includes('CLIENT_OK'))).toBe(true);
  });

  it('preserves prior evidence, releases held input, and does not re-execute failed code', async () => {
    const { mock, app } = await runtimeWith();
    const batch = evidenceBatchSchema.parse({ actions: [
      { id: 'held', kind: 'keyboard', target: 'client-1', key_code: 'LeftShift', action: 'press' },
      { id: 'failure', kind: 'luau', role: 'client-1', source: 'error("CLIENT_FAIL")' },
    ] });
    const value = await app.managedRuntime.scenario({ play_mode: 'play', batch });
    expect(value.report).toMatchObject({ success: false, error_code: 'CALLER_LUAU_FAILED', actions: [{ success: true }, { success: false, role: 'client-1', retry_performed: false }], cleanup: { input_releases: 1, owned_playtest_stopped: true } });
    expect(mock.calls.filter((call) => call.name === 'eval_client_runtime' && String(call.args.code).includes('CLIENT_FAIL'))).toHaveLength(1);
    expect(mock.calls.filter((call) => call.name === 'simulate_keyboard_input')).toHaveLength(2);
  });

  it('protects caller-owned Play and returns actionable acquisition failures', async () => {
    const mock = new V4Mock(); mock.running = true; mock.callerOwned = true;
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-v4-owned-'));
    const managed = new ManagedRuntime(mock, new Telemetry(root));
    managed.noteCallerLifecycleStart(undefined, ['server', 'client-1']);
    const begun = await managed.begin({ play_mode: 'play' });
    const finished = await managed.finish(begun.session.id);
    expect(finished.cleanup).toMatchObject({ caller_playtest_preserved: true, owned_playtest_stopped: false });
    expect(mock.calls.filter((call) => call.name === 'solo_playtest' && call.args.action === 'stop')).toHaveLength(0);

    const failedMock = new V4Mock(); failedMock.failStatus = true;
    const failed = new ManagedRuntime(failedMock, new Telemetry(root));
    const report = await failed.scenario({ play_mode: 'play', batch: evidenceBatchSchema.parse({}) });
    expect(report.report).toMatchObject({ success: false, error_code: 'TEST_ACQUISITION_FAILED', failure: { retryable: 'unknown', stage: 'lifecycle status/start' }, cleanup: { outcome: 'not_owned' } });
    expect(report.report.recommended_next_action).toMatch(/connectivity|role health/i);
  });
});
