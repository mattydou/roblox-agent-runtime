import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ChrrxsAdapter, RuntimeLogCollectionOptions } from '../src/chrrxs/adapter.js';
import { compileEvidenceHarness } from '../src/runtime/evidence-luau.js';
import { evaluateAssertion, ManagedRuntime } from '../src/runtime/managed-runtime.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { evidenceBatchSchema } from '../src/tools/schemas.js';

class EvidenceMock implements ChrrxsAdapter {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  running = false;
  failTool = false;
  order: string[] = [];

  async start() {}
  async close() {}
  async listTools() { return []; }
  startRuntimeLogSession() {}
  updateRuntimeLogSession() {}
  endRuntimeLogSession() {}
  async collectRuntimeLogs(_options: RuntimeLogCollectionOptions) {
    this.order.push('logs');
    return { entries: [], captures: [], capture_errors: {}, partial: false };
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    this.calls.push({ name, args });
    return { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] };
  }
  async callJson(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'solo_playtest') {
      const action = String(args.action);
      if (action === 'status') return { success: true, running: this.running, roles: this.running ? ['server', 'client-1'] : [] };
      if (action === 'start') { this.running = true; this.order.push('start'); return { success: true, running: true, roles: ['server', 'client-1'] }; }
      if (action === 'stop') { this.running = false; this.order.push('stop'); return { success: true, running: false }; }
    }
    if (name === 'eval_server_runtime' || name === 'eval_client_runtime') {
      const code = String(args.code ?? '');
      let value: Record<string, unknown> = { success: true };
      if (code.includes('"operation":"probe"')) value = { success: true, probes: [{ id: 'present', kind: 'exists', context: 'server', path: 'game.Workspace.Part', exists: true }] };
      if (code.includes('"operation":"collect"')) value = {
        success: true,
        watches: [
          { id: 'activated', kind: 'signal', context: 'client-1', occurrence_count: 0, events: [], dropped: 0, truncated: false },
          { id: 'changes', kind: 'property_change', context: 'server', initial_value: 2, final_value: 2, change_count: 0, occurrence_count: 0, events: [] },
          { id: 'spawned', kind: 'instance_lifecycle', context: 'server', added_count: 1, removed_count: 1, events: [{ event: 'added', time: 0.01 }, { event: 'removed', time: 0.02 }] },
        ],
        series: [{ id: 'trace', context: 'server', initial_value: 1, final_value: 3, sample_count: 3, samples: [{ time: 0, value: 1 }, { time: 0.1, value: 2 }, { time: 0.2, value: 3 }], dropped: 0, missed: 0, truncated: false }],
      };
      if (code.includes('"operation":"tool"')) value = this.failTool ? { success: false, error_code: 'WRONG_CLASS' } : { success: true, operation: 'activate' };
      return { success: true, returnValue: JSON.stringify(value) };
    }
    return { success: true };
  }
}

async function manager(mock = new EvidenceMock()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-evidence-'));
  let clock = 0;
  return {
    mock,
    runtime: new ManagedRuntime(mock, new Telemetry(root), {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }),
  };
}

const emptyBatch = () => evidenceBatchSchema.parse({});

describe('managed evidence sessions', () => {
  it('uses one owned playtest across multiple batches and stops exactly once after final logs', async () => {
    const { mock, runtime } = await manager();
    const begun = await runtime.begin({ play_mode: 'play' });
    const acquiredAgain = await runtime.begin({ play_mode: 'play' });
    expect(acquiredAgain.session.id).toBe(begun.session.id);
    expect(acquiredAgain.lifecycle.transitions).toContain('existing_session_reused');
    await runtime.runBatch(begun.session.id, emptyBatch());
    await runtime.runBatch(begun.session.id, emptyBatch());
    const finished = await runtime.finish(begun.session.id);
    await runtime.finish(begun.session.id);
    expect(mock.order.filter((item) => item === 'start')).toHaveLength(1);
    expect(mock.order.filter((item) => item === 'stop')).toHaveLength(1);
    expect(mock.order.indexOf('logs')).toBeLessThan(mock.order.indexOf('stop'));
    expect(finished.summary).toMatchObject({ batches: 2, successful_batches: 2 });
    expect(finished.cleanup).toMatchObject({ owned_playtest_stopped: true, input_releases: 0 });
  });

  it('reuses a wrapper-known caller playtest and never stops it', async () => {
    const { mock, runtime } = await manager();
    mock.running = true;
    runtime.noteCallerLifecycleStart(undefined, ['server', 'client-1']);
    const begun = await runtime.begin({ play_mode: 'play' });
    expect(begun.session.ownership).toBe('caller-owned');
    const finished = await runtime.finish(begun.session.id);
    expect(mock.order).not.toContain('stop');
    expect(finished.cleanup).toMatchObject({ caller_playtest_preserved: true });
  });

  it('marks wrapper-mediated revisions stale and refreshes an owned session at most once', async () => {
    const { mock, runtime } = await manager();
    const begun = await runtime.begin({ play_mode: 'play' });
    runtime.notePersistentMutation('roblox_edit');
    const stale = await runtime.runBatch(begun.session.id, emptyBatch());
    expect(stale.report).toMatchObject({ success: false, error_code: 'TEST_SESSION_STALE', failure_kind: 'stale' });
    expect(mock.order.filter((item) => item === 'start')).toHaveLength(1);
    const refreshed = await runtime.runBatch(begun.session.id, emptyBatch(), true);
    expect(refreshed.report.session).toMatchObject({ revision: 'r1', current_revision: 'r1', refresh_count: 1 });
    expect(mock.order.filter((item) => item === 'start')).toHaveLength(2);
    runtime.notePersistentMutation('roblox_edit');
    expect((await runtime.runBatch(begun.session.id, emptyBatch(), true)).report.error_code).toBe('TEST_SESSION_STALE');
  });

  it('maps input actions, records timestamps, and releases a held key after failure', async () => {
    const { mock, runtime } = await manager();
    mock.failTool = true;
    const begun = await runtime.begin({ play_mode: 'play' });
    const batch = evidenceBatchSchema.parse({ actions: [
      { id: 'held', kind: 'keyboard', target: 'client-1', key_code: 'E', action: 'press' },
      { id: 'bad_tool', kind: 'tool', context: 'client-1', operation: 'activate', target: 'NotATool' },
    ] });
    const result = await runtime.runBatch(begun.session.id, batch);
    expect(result.report).toMatchObject({ success: false, failure_kind: 'behavioral' });
    expect(result.report.actions[0]).toMatchObject({ id: 'held', context: 'client-1', success: true, start_time: 0, end_time: 0 });
    expect(result.report.actions[1]).toMatchObject({ success: false, details: { error_code: 'WRONG_CLASS' } });
    await runtime.finish(begun.session.id);
    const keyboard = mock.calls.filter((item) => item.name === 'simulate_keyboard_input').map((item) => item.args);
    expect(keyboard).toEqual([
      expect.objectContaining({ keyCode: 'E', action: 'press', target: 'client-1' }),
      expect.objectContaining({ keyCode: 'E', action: 'release', target: 'client-1' }),
    ]);
  });

  it('routes probes and watches to their roles and retains objective negative and time-series evidence', async () => {
    const { runtime } = await manager();
    const begun = await runtime.begin({ play_mode: 'play' });
    const batch = evidenceBatchSchema.parse({
      checkpoints: [{ id: 'after_state', phase: 'after', probes: [{ id: 'present', kind: 'exists', context: 'server', path: 'game.Workspace.Part' }] }],
      watches: [
        { id: 'activated', kind: 'signal', context: 'client-1', path: 'game.Workspace.TestTool', signal: 'Activated' },
        { id: 'changes', kind: 'property_change', context: 'server', path: 'game.Workspace.Counter', property: 'Value' },
        { id: 'spawned', kind: 'instance_lifecycle', context: 'server', path: 'game.Workspace', name: 'Transient', class_name: 'Part' },
      ],
      series: [{ id: 'trace', probe: { kind: 'property', context: 'server', path: 'game.Workspace.Counter', property: 'Value' }, interval_ms: 100, duration_ms: 200 }],
      assertions: [
        { id: 'exists_ok', evidence: 'present', condition: 'exists' },
        { id: 'negative_ok', evidence: 'activated', condition: 'zero_occurrences' },
        { id: 'unchanged_ok', evidence: 'changes', condition: 'unchanged' },
        { id: 'delta_ok', evidence: 'trace', condition: 'exact_numeric_delta', expected: 2 },
        { id: 'short_lived_ok', evidence: 'spawned', condition: 'exact_count', expected: 1 },
      ],
    });
    const result = await runtime.runBatch(begun.session.id, batch);
    expect(result.report.success).toBe(true);
    expect(result.report.assertions.every((item) => item.passed)).toBe(true);
    expect(result.report.series[0]).toMatchObject({ initial_value: 1, final_value: 3, truncated: false });
    expect(result.report.watches.find((item) => item.id === 'spawned')).toMatchObject({ added_count: 1, removed_count: 1 });
  });

  it('distinguishes missing evidence from a passing zero-occurrence assertion', () => {
    const negative = { id: 'negative', evidence: 'watch', condition: 'zero_occurrences', tolerance: 0 } as const;
    expect(evaluateAssertion(negative, { occurrence_count: 0 })).toMatchObject({ status: 'evaluated', passed: true });
    expect(evaluateAssertion(negative, undefined)).toMatchObject({ status: 'missing_evidence', passed: false });
  });

  it('publishes a fixed marked harness that refuses unmarked cleanup and contains no caller source', () => {
    const source = compileEvidenceHarness({ operation: 'begin', session_id: 's', role: 'server', revision: 'r0' });
    expect(source).toContain('RobloxAgentManagedEvidence');
    expect(source).toContain('UNMARKED_EVIDENCE_HARNESS_CONFLICT');
    expect(source).toContain('REFUSING_UNMARKED_HARNESS_CLEANUP');
    expect(source).toContain('prior:Destroy()');
    expect(source).not.toContain('loadstring');
  });

  it('enforces action, wait, probe, sampling, and reference bounds before Studio', () => {
    expect(evidenceBatchSchema.safeParse({ actions: Array.from({ length: 21 }, () => ({ kind: 'wait', duration_ms: 1 })) }).success).toBe(false);
    expect(evidenceBatchSchema.safeParse({ actions: [{ kind: 'wait', duration_ms: 5_000 }, { kind: 'wait', duration_ms: 5_001 }] }).success).toBe(false);
    expect(evidenceBatchSchema.safeParse({ series: [{ id: 'too_many', probe: { kind: 'exists', context: 'server', path: 'game.Workspace' }, interval_ms: 50, duration_ms: 10_000 }] }).success).toBe(false);
    expect(evidenceBatchSchema.safeParse({ checkpoints: Array.from({ length: 3 }, (_, group) => ({ id: `group${group}`, probes: Array.from({ length: 20 }, (_, index) => ({ id: `p${group}_${index}`, kind: 'exists', context: 'server', path: 'game.Workspace' })) })) }).success).toBe(false);
    expect(evidenceBatchSchema.safeParse({ assertions: [{ id: 'unknown', evidence: 'missing', condition: 'exists' }] }).success).toBe(false);
    expect(evidenceBatchSchema.safeParse({ actions: [{ kind: 'keyboard', target: 'server', key_code: 'E' }] }).success).toBe(false);
  });
});
