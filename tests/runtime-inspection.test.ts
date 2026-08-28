import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ChrrxsAdapter, RuntimeLogCollection, RuntimeLogCollectionOptions } from '../src/chrrxs/adapter.js';
import { compileRuntimeInspection } from '../src/runtime/luau.js';
import { RobloxAgentRuntime } from '../src/runtime/app.js';
import { Telemetry } from '../src/runtime/telemetry.js';

class RuntimeInspectMock implements ChrrxsAdapter {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  async start() {} async close() {} async listTools() { return []; }
  startRuntimeLogSession() {} updateRuntimeLogSession() {} endRuntimeLogSession() {}
  async collectRuntimeLogs(_options: RuntimeLogCollectionOptions): Promise<RuntimeLogCollection> { return { entries: [], captures: [], capture_errors: {}, partial: false }; }
  async call(): Promise<CallToolResult> { return { content: [] }; }
  async callJson(name: string, args: Record<string, unknown> = {}) {
    this.calls.push({ name, args });
    return { success: true, returnValue: JSON.stringify({ success: true, result: [{ path: 'game.Workspace.Live' }] }) };
  }
}

describe('read-only runtime DataModel inspection', () => {
  it('routes server and selected client reads through fixed eval tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-inspect-'));
    const mock = new RuntimeInspectMock();
    const runtime = new RobloxAgentRuntime(mock, new Telemetry(root), root);
    await runtime.dispatch('roblox_inspect', { mode: 'hierarchy', context: 'server', path: 'game.Workspace', depth: 2, max_results: 7 });
    await runtime.dispatch('roblox_observe', { mode: 'state', context: 'client-2', path: 'game.Workspace.Live', properties: ['Name'] });
    expect(mock.calls.map((call) => call.name)).toEqual(['eval_server_runtime', 'eval_client_runtime']);
    expect(mock.calls[1]!.args.target).toBe('client-2');
    expect(String(mock.calls[0]!.args.code)).toContain('request.max_results');
  });

  it('encodes paths/queries as JSON data and keeps traversal limits in the source', () => {
    const malicious = 'x\"]]); error("INJECTED") --';
    const source = compileRuntimeInspection({ mode: 'search', query: malicious, search_by: 'name', max_results: 3 });
    expect(source).not.toContain(`request.query = ${malicious}`);
    expect(source).toContain('JSONDecode');
    expect(source).toContain('#results >= request.max_results');
  });

  it('rejects invalid peers and unsupported runtime combinations before routing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-inspect-'));
    const mock = new RuntimeInspectMock();
    const runtime = new RobloxAgentRuntime(mock, new Telemetry(root), root);
    expect((await runtime.dispatch('roblox_inspect', { mode: 'hierarchy', context: 'client-zero' })).isError).toBe(true);
    expect((await runtime.dispatch('roblox_inspect', { mode: 'search', context: 'server', query: 'x', search_by: 'content' })).isError).toBe(true);
    expect((await runtime.dispatch('roblox_inspect', { mode: 'properties', context: 'server', path: 'game.Workspace' })).isError).toBe(true);
    expect(mock.calls).toHaveLength(0);
  });
});
