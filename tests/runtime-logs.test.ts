import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ChrrxsAdapter, RuntimeLogCollection, RuntimeLogCollectionOptions } from '../src/chrrxs/adapter.js';
import { ChrrxsClient } from '../src/chrrxs/client.js';
import { RobloxAgentRuntime } from '../src/runtime/app.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { findRuntimeErrors } from '../src/tools/test.js';

class LogClient extends ChrrxsClient {
  calls: Array<{ target: string; since?: number }> = [];
  serverCursor = 1;
  staleClient = true;

  override async call(_name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const target = String(args.target);
    this.calls.push({ target, ...(typeof args.since === 'number' ? { since: args.since } : {}) });
    if (target === 'client-1' && this.staleClient) throw new Error('client-1 timed out after bounded wait');
    const seq = this.serverCursor++;
    return {
      content: [{ type: 'text', text: JSON.stringify({
        entries: [{ seq, ts: seq, level: seq === 2 ? 'Error' : 'Info', message: seq === 2 ? 'boom' : `line-${seq}` }],
        nextSince: seq + 1,
        originPeerReliable: true,
        peerAttribution: 'guaranteed_multiplayer',
      }) }],
    };
  }
}

class LifecycleMock implements ChrrxsAdapter {
  events: string[] = [];
  targets: string[] = [];
  async start() {}
  async close() {}
  async listTools() { return []; }
  async call(): Promise<CallToolResult> { return { content: [] }; }
  async callJson(name: string, args: Record<string, unknown> = {}) {
    this.events.push(`${name}:${String(args.action ?? '')}`);
    return { success: true, roles: ['server', 'client-1'] };
  }
  startRuntimeLogSession(_instanceId: string | undefined, targets: string[]) { this.targets = targets; this.events.push('logs:start'); }
  updateRuntimeLogSession(_instanceId: string | undefined, targets: string[]) { this.targets = [...new Set([...this.targets, ...targets])]; }
  endRuntimeLogSession() { this.targets = []; this.events.push('logs:end'); }
  async collectRuntimeLogs(_options: RuntimeLogCollectionOptions): Promise<RuntimeLogCollection> {
    this.events.push('logs:collect');
    return {
      entries: [{ level: 'Error', message: 'runtime error', capturedBy: 'server' }],
      captures: [{ target: 'server', cursor_before: 3, cursor_after: 4, cursor_reused: true, entries: [], total_dropped: 0 }],
      capture_errors: {},
      partial: false,
    };
  }
}

describe('incremental runtime logs', () => {
  it('advances/reuses cursors and preserves responsive logs when a client is stale', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-logs-'));
    const client = new LogClient({ cwd: root, taskId: async () => null, telemetry: new Telemetry(root) });
    client.startRuntimeLogSession(undefined, ['server', 'client-1']);
    const first = await client.collectRuntimeLogs({ tail: 20, timeout_ms: 100 });
    expect(first.partial).toBe(true);
    expect(first.entries).toMatchObject([{ message: 'line-1', capturedBy: 'server' }]);
    expect(first.capture_errors['client-1']).toMatch(/timed out/);

    const second = await client.collectRuntimeLogs({ tail: 20, timeout_ms: 100 });
    expect(client.calls.filter((call) => call.target === 'server')).toEqual([
      { target: 'server' }, { target: 'server', since: 2 },
    ]);
    expect(second.captures.find((capture) => capture.target === 'server')).toMatchObject({ cursor_reused: true, cursor_before: 2, cursor_after: 3 });
    expect(second.entries).toHaveLength(1);
    expect(findRuntimeErrors(second.entries)).toHaveLength(1);

    await client.collectRuntimeLogs({ targets: ['server'], since: 0, tail: 20, timeout_ms: 100 });
    await client.collectRuntimeLogs({ targets: ['server'], tail: 20, timeout_ms: 100 });
    expect(client.calls.at(-1)?.since).toBe(3);

    client.endRuntimeLogSession(undefined);
    client.startRuntimeLogSession(undefined, ['server']);
    await client.collectRuntimeLogs({ tail: 20, timeout_ms: 100 });
    expect(client.calls.at(-1)).toEqual({ target: 'server' });
  });

  it('does not implicitly collect on start/status and collects before stop', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-logs-'));
    const mock = new LifecycleMock();
    const runtime = new RobloxAgentRuntime(mock, new Telemetry(root), root);
    await runtime.dispatch('roblox_test', { mode: 'solo', action: 'start' });
    await runtime.dispatch('roblox_test', { mode: 'solo', action: 'status' });
    expect(mock.events.filter((event) => event === 'logs:collect')).toHaveLength(0);
    await runtime.dispatch('roblox_test', { mode: 'solo', action: 'stop' });
    expect(mock.events.slice(-3)).toEqual(['logs:collect', 'solo_playtest:stop', 'logs:end']);
  });

  it('records exactly one start evidence item when a task is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-logs-'));
    const mock = new LifecycleMock();
    const runtime = new RobloxAgentRuntime(mock, new Telemetry(root), root);
    await runtime.dispatch('roblox_task', { action: 'begin', goal: 'playtest' });
    await runtime.dispatch('roblox_test', { mode: 'solo', action: 'start' });
    const evidence = (await runtime.tasks.current())!.completed_operations.filter((item) => item.operation === 'solo_start');
    expect(evidence).toHaveLength(1);
  });
});
