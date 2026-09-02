import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approximateBytes, Telemetry } from '../src/runtime/telemetry.js';

describe('telemetry', () => {
  it('writes separate JSONL streams with byte counts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-telemetry-'));
    const telemetry = new Telemetry(root);
    await telemetry.model({ timestamp: 'now', task_id: 't', public_tool: 'roblox_inspect', public_operation: 'status', duration_ms: 1, request_bytes: 2, response_bytes: 3, success: true, evidence_session_event: 'batch', action_count: 2, assertion_failures: 1 });
    await telemetry.internal({ timestamp: 'now', task_id: 't', chrrxs_tool: 'get_place_info', duration_ms: 2, request_bytes: 3, response_bytes: 4, success: false });
    expect(JSON.parse(await readFile(path.join(root, 'logs', 'model-visible.jsonl'), 'utf8'))).toMatchObject({
      public_tool: 'roblox_inspect', runtime_version: '0.5.0', chrrxs_version: '3.0.3', evidence_session_event: 'batch', action_count: 2, assertion_failures: 1,
    });
    expect(JSON.parse(await readFile(path.join(root, 'logs', 'chrrxs-internal.jsonl'), 'utf8'))).toMatchObject({
      chrrxs_tool: 'get_place_info', runtime_version: '0.5.0', chrrxs_version: '3.0.3',
    });
    expect(approximateBytes({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}'));
  });
});
