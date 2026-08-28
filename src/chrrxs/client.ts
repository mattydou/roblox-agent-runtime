import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { approximateBytes, RUNTIME_VERSION, Telemetry } from '../runtime/telemetry.js';
import { parseTextJson } from '../runtime/result-normalizer.js';
import type { RuntimeLogCapture, RuntimeLogCollection, RuntimeLogCollectionOptions } from './adapter.js';

export const CHRRXS_VERSION = '3.0.3';

export function extractJsonToolResult(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.find((block) => block.type === 'text');
  if (!text || text.type !== 'text') return result.content;
  return parseTextJson(text.text);
}

export interface ChrrxsClientOptions {
  cwd: string;
  autoInstallPlugin?: boolean;
  extraArgs?: string[];
  taskId: () => Promise<string | null>;
  telemetry: Telemetry;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export class ChrrxsClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private starting: Promise<void> | null = null;
  private closedUnexpectedly = false;
  private readonly logCursors = new Map<string, number>();
  private readonly logTargets = new Map<string, string[]>();

  constructor(private readonly options: ChrrxsClientOptions) {}

  async start(): Promise<void> {
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = this.startInner();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInner(): Promise<void> {
    const require = createRequire(import.meta.url);
    const entrypoint = require.resolve('@chrrxs/robloxstudio-mcp');
    const args = [entrypoint];
    if (this.options.autoInstallPlugin) args.push('--auto-install-plugin');
    args.push(...(this.options.extraArgs ?? []));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      cwd: this.options.cwd,
      env: processEnvironment(),
      stderr: 'pipe',
      maxBufferSize: 32 * 1024 * 1024,
    });
    const stderr = transport.stderr as NodeJS.ReadableStream | null;
    stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      void this.options.telemetry.childStderr(text).catch((error) => {
        console.error(`Failed to record Chrrxs stderr: ${error instanceof Error ? error.message : String(error)}`);
      });
    });

    const client = new Client(
      { name: 'roblox-agent-runtime', version: RUNTIME_VERSION },
      { capabilities: {} },
    );
    client.onerror = (error) => console.error(`Chrrxs MCP error: ${error.message}`);
    client.onclose = () => {
      if (this.client) {
        this.closedUnexpectedly = true;
        console.error('Chrrxs MCP subprocess closed unexpectedly');
      }
      this.client = null;
      this.transport = null;
    };

    try {
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.closedUnexpectedly = false;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw new Error(`Unable to start Chrrxs MCP subprocess: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listTools(): Promise<string[]> {
    await this.start();
    const response = await this.requireClient().listTools();
    return response.tools.map((tool) => tool.name);
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 60_000,
    diagnostics: { capture_target?: string; cursor_reused?: boolean; cursor_before?: number } = {},
  ): Promise<CallToolResult> {
    await this.start();
    const taskId = await this.options.taskId();
    const started = performance.now();
    let response: unknown;
    let success = false;
    let cursorAfter: number | undefined;
    let partialFailureReason: string | undefined;
    try {
      response = await this.requireClient().callTool(
        { name, arguments: args },
        undefined,
        { timeout: timeoutMs, resetTimeoutOnProgress: true },
      );
      const result = response as CallToolResult;
      if (result.isError) {
        throw new Error(this.errorText(result) ?? `Chrrxs tool ${name} returned isError`);
      }
      const semanticError = this.semanticError(name, result);
      if (semanticError) throw new Error(semanticError);
      if (name === 'get_runtime_logs') {
        const parsed = extractJsonToolResult(result);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const nextSince = (parsed as Record<string, unknown>).nextSince;
          if (typeof nextSince === 'number') cursorAfter = nextSince;
        }
      }
      success = true;
      return result;
    } catch (error) {
      partialFailureReason = error instanceof Error ? error.message : String(error);
      response = response ?? { error: error instanceof Error ? error.message : String(error) };
      if (this.closedUnexpectedly) {
        throw new Error(`Chrrxs subprocess terminated while calling ${name}`);
      }
      throw error;
    } finally {
      await this.options.telemetry.internal({
        timestamp: new Date().toISOString(),
        task_id: taskId,
        chrrxs_tool: name,
        duration_ms: Math.round((performance.now() - started) * 100) / 100,
        request_bytes: approximateBytes(args),
        response_bytes: approximateBytes(response),
        success,
        ...diagnostics,
        ...(cursorAfter === undefined ? {} : { cursor_after: cursorAfter }),
        ...(partialFailureReason === undefined ? {} : { partial_failure_reason: partialFailureReason }),
      });
    }
  }

  async callJson(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const result = await this.call(name, args, timeoutMs);
    return extractJsonToolResult(result);
  }

  startRuntimeLogSession(instanceId: string | undefined, targets: string[]): void {
    this.endRuntimeLogSession(instanceId);
    this.logTargets.set(this.instanceKey(instanceId), this.validLogTargets(targets));
  }

  updateRuntimeLogSession(instanceId: string | undefined, targets: string[]): void {
    const key = this.instanceKey(instanceId);
    this.logTargets.set(key, this.validLogTargets([...(this.logTargets.get(key) ?? []), ...targets]));
  }

  endRuntimeLogSession(instanceId: string | undefined): void {
    const prefix = `${this.instanceKey(instanceId)}\u0000`;
    for (const key of this.logCursors.keys()) if (key.startsWith(prefix)) this.logCursors.delete(key);
    this.logTargets.delete(this.instanceKey(instanceId));
  }

  async collectRuntimeLogs(options: RuntimeLogCollectionOptions): Promise<RuntimeLogCollection> {
    const instanceKey = this.instanceKey(options.instance_id);
    const retained = this.logTargets.get(instanceKey) ?? [];
    const requested = options.targets?.length ? options.targets : retained;
    const targets = this.validLogTargets(requested.length ? requested : ['edit']);
    const captures: RuntimeLogCapture[] = await Promise.all(targets.map(async (target): Promise<RuntimeLogCapture> => {
      const cursorKey = `${instanceKey}\u0000${target}`;
      const retainedCursor = this.logCursors.get(cursorKey);
      const cursorBefore = options.since ?? retainedCursor;
      const cursorReused = options.since === undefined && retainedCursor !== undefined;
      try {
        const value = await this.call(
          'get_runtime_logs',
          {
            target,
            ...(cursorBefore === undefined ? {} : { since: cursorBefore }),
            tail: options.tail,
            ...(options.filter ? { filter: options.filter } : {}),
            ...(options.instance_id ? { instance_id: options.instance_id } : {}),
          },
          options.timeout_ms ?? 3_000,
          { capture_target: target, cursor_reused: cursorReused, ...(cursorBefore === undefined ? {} : { cursor_before: cursorBefore }) },
        );
        const parsed = extractJsonToolResult(value);
        const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
        const cursorAfter = typeof record.nextSince === 'number' ? record.nextSince : undefined;
        // Explicit replay/debug cursors must not rewind the retained live-session cursor.
        if (cursorAfter !== undefined && options.since === undefined) this.logCursors.set(cursorKey, cursorAfter);
        const entries = Array.isArray(record.entries)
          ? record.entries.map((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
            ? { ...(entry as Record<string, unknown>), capturedBy: target }
            : { value: entry, capturedBy: target })
          : [];
        const reliability = Object.fromEntries(
          ['originPeerReliable', 'peerAttribution', 'totalDropped'].flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]]),
        );
        return {
          target,
          ...(cursorBefore === undefined ? {} : { cursor_before: cursorBefore }),
          ...(cursorAfter === undefined ? {} : { cursor_after: cursorAfter }),
          cursor_reused: cursorReused,
          entries,
          total_dropped: typeof record.totalDropped === 'number' ? record.totalDropped : 0,
          ...(Object.keys(reliability).length ? { reliability } : {}),
        };
      } catch (error) {
        return {
          target,
          ...(cursorBefore === undefined ? {} : { cursor_before: cursorBefore }),
          cursor_reused: cursorReused,
          entries: [],
          total_dropped: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    const deduped = new Map<string, Record<string, unknown>>();
    for (const capture of captures) {
      for (const rawEntry of capture.entries) {
        const entry = rawEntry as Record<string, unknown>;
        const key = JSON.stringify([entry.ts, entry.seq, entry.level, entry.message ?? entry.text]);
        const existing = deduped.get(key);
        if (!existing) {
          deduped.set(key, entry);
        } else {
          const current = Array.isArray(existing.capturedBy) ? existing.capturedBy : [existing.capturedBy];
          existing.capturedBy = [...new Set([...current, entry.capturedBy])];
        }
      }
    }
    const entries = [...deduped.values()].sort((left, right) => Number(left.ts ?? 0) - Number(right.ts ?? 0));
    const captureErrors = Object.fromEntries(captures.flatMap((capture) => capture.error ? [[capture.target, capture.error]] : []));
    return { entries, captures, capture_errors: captureErrors, partial: Object.keys(captureErrors).length > 0 };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) await client.close().catch(() => undefined);
  }

  private instanceKey(instanceId: string | undefined): string {
    return instanceId ?? '<single>';
  }

  private validLogTargets(targets: string[]): string[] {
    const unique = [...new Set(targets)];
    for (const target of unique) {
      if (!/^(edit|server|client-[1-9][0-9]*)$/.test(target)) {
        throw new Error(`invalid runtime log capture target: ${target}`);
      }
    }
    return unique;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('Chrrxs MCP subprocess is not connected');
    return this.client;
  }

  private errorText(result: CallToolResult): string | null {
    if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
      const structured = result.structuredContent as Record<string, unknown>;
      if (typeof structured.message === 'string') return structured.message;
      if (typeof structured.error === 'string') return structured.error;
    }
    const text = result.content.find((block) => block.type === 'text');
    return text?.type === 'text' ? text.text : null;
  }

  private semanticError(name: string, result: CallToolResult): string | null {
    if (name === 'capture_screenshot' && !result.content.some((block) => block.type === 'image')) {
      return this.errorText(result) ?? 'capture_screenshot returned no image';
    }
    const parsed = result.structuredContent ?? (() => {
      const text = this.errorText(result);
      return text ? parseTextJson(text) : undefined;
    })();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.success === false) return String(record.error ?? record.message ?? `${name} failed`);
    if (typeof record.error === 'string' && record.success !== true) return record.error;
    return null;
  }
}
