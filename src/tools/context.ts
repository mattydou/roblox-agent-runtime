import type { ChrrxsAdapter } from '../chrrxs/adapter.js';
import type { TaskStore } from '../runtime/task-store.js';
import type { ManagedRuntime } from '../runtime/managed-runtime.js';
import type { ViewportController } from '../runtime/viewport-controller.js';

export interface ToolContext {
  chrrxs: ChrrxsAdapter;
  tasks: TaskStore;
  managedRuntime: ManagedRuntime;
  viewport: ViewportController;
}

export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | Record<string, unknown>
  >;
  isError?: boolean;
  telemetry?: Record<string, unknown>;
}

export function textResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}
