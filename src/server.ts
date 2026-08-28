#!/usr/bin/env node
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CHRRXS_VERSION, ChrrxsClient } from './chrrxs/client.js';
import { RobloxAgentRuntime } from './runtime/app.js';
import { TaskStore } from './runtime/task-store.js';
import { RUNTIME_VERSION, Telemetry } from './runtime/telemetry.js';

const REQUIRED_CHRRXS_TOOLS = [
  'get_connected_instances', 'get_place_info', 'get_project_structure', 'search_objects',
  'get_instance_properties', 'grep_scripts', 'get_script_source', 'selection', 'get_runtime_logs',
  'execute_luau', 'solo_playtest', 'multiplayer_playtest', 'capture_screenshot',
  'eval_server_runtime', 'eval_client_runtime',
];

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.toLowerCase() ?? '');
}

async function main(): Promise<void> {
  const runtimeDir = path.resolve(process.env.ROBLOX_AGENT_RUNTIME_DIR ?? path.join(process.cwd(), '.runtime'));
  const telemetry = new Telemetry(runtimeDir);
  const taskReader = new TaskStore(runtimeDir);
  const autoInstallPlugin = process.argv.includes('--auto-install-plugin') || enabled(process.env.ROBLOX_AGENT_AUTO_INSTALL_PLUGIN);
  const extraArgs = process.env.ROBLOX_AGENT_CHRRXS_ARGS
    ? JSON.parse(process.env.ROBLOX_AGENT_CHRRXS_ARGS) as unknown
    : [];
  if (!Array.isArray(extraArgs) || !extraArgs.every((arg) => typeof arg === 'string')) {
    throw new Error('ROBLOX_AGENT_CHRRXS_ARGS must be a JSON array of strings');
  }
  const chrrxs = new ChrrxsClient({
    cwd: process.cwd(),
    autoInstallPlugin,
    extraArgs,
    taskId: () => taskReader.currentId(),
    telemetry,
  });
  await chrrxs.start();
  const upstreamTools = new Set(await chrrxs.listTools());
  const missing = REQUIRED_CHRRXS_TOOLS.filter((tool) => !upstreamTools.has(tool));
  if (missing.length) {
    await chrrxs.close();
    throw new Error(`Pinned Chrrxs server is missing required tools: ${missing.join(', ')}`);
  }

  const runtime = new RobloxAgentRuntime(chrrxs, telemetry, runtimeDir);
  const server = new Server(
    { name: 'roblox-agent-runtime', version: RUNTIME_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: runtime.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return runtime.dispatch(request.params.name, request.params.arguments ?? {}) as never;
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    await chrrxs.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  process.stdin.once('end', () => void close());
  process.stdin.once('close', () => void close());

  await server.connect(new StdioServerTransport());
  console.error(`roblox-agent-runtime v${RUNTIME_VERSION} running on stdio; Chrrxs pinned at ${CHRRXS_VERSION}`);
}

main().catch((error) => {
  console.error(`roblox-agent-runtime failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
