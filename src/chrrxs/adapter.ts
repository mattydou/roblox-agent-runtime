import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface RuntimeLogCollectionOptions {
  instance_id?: string;
  targets?: string[];
  since?: number;
  tail: number;
  filter?: string;
  timeout_ms?: number;
}

export interface RuntimeLogCapture {
  target: string;
  cursor_before?: number;
  cursor_after?: number;
  cursor_reused: boolean;
  entries: unknown[];
  total_dropped: number;
  reliability?: Record<string, unknown>;
  error?: string;
}

export interface RuntimeLogCollection {
  entries: unknown[];
  captures: RuntimeLogCapture[];
  capture_errors: Record<string, string>;
  partial: boolean;
}

export interface ChrrxsAdapter {
  start(): Promise<void>;
  listTools(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<CallToolResult>;
  callJson(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  startRuntimeLogSession(instanceId: string | undefined, targets: string[]): void;
  updateRuntimeLogSession(instanceId: string | undefined, targets: string[]): void;
  endRuntimeLogSession(instanceId: string | undefined): void;
  collectRuntimeLogs(options: RuntimeLogCollectionOptions): Promise<RuntimeLogCollection>;
  close(): Promise<void>;
}
