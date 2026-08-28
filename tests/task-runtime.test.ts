import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChrrxsAdapter } from '../src/chrrxs/adapter.js';
import { RobloxAgentRuntime } from '../src/runtime/app.js';
import { Telemetry } from '../src/runtime/telemetry.js';

describe('compact task public responses', () => {
  it('does not echo a growing task record for mutations or default status', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'task-runtime-'));
    const runtime = new RobloxAgentRuntime({} as ChrrxsAdapter, new Telemetry(root), root);
    const begin = await runtime.dispatch('roblox_task', {
      action: 'begin', goal: 'compact',
      plan: Array.from({ length: 50 }, (_, index) => ({ id: `step-${index}`, description: 'x'.repeat(100) })),
    });
    const beginText = (begin.content[0] as { text: string }).text;
    expect(Buffer.byteLength(beginText)).toBeLessThan(1_000);
    expect(beginText).not.toContain('completed_operations');
    const status = await runtime.dispatch('roblox_task', { action: 'status' });
    expect(Buffer.byteLength((status.content[0] as { text: string }).text)).toBeLessThan(1_000);
    const full = await runtime.dispatch('roblox_task', { action: 'status', detail: 'full' });
    expect(Buffer.byteLength((full.content[0] as { text: string }).text)).toBeGreaterThan(5_000);
  });
});
