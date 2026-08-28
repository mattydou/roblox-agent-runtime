import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

describe('stdio MCP server', () => {
  it('initializes and exposes only the six public tools', async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-server-'));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.ROBLOX_AGENT_RUNTIME_DIR = runtimeDir;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/server.js')],
      cwd: process.cwd(),
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'protocol-test', version: '0.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const response = await client.listTools();
      expect(response.tools.map((tool) => tool.name)).toEqual([
        'roblox_task', 'roblox_inspect', 'roblox_edit', 'roblox_author', 'roblox_test', 'roblox_observe',
      ]);
      expect(response.tools.some((tool) => tool.name === 'execute_luau')).toBe(false);
      const status = await client.callTool({ name: 'roblox_task', arguments: { action: 'status' } });
      expect(status.isError).not.toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});

