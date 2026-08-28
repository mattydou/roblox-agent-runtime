import type { ChrrxsAdapter } from '../chrrxs/adapter.js';
import type { TaskStore } from '../runtime/task-store.js';

export interface ToolContext {
  chrrxs: ChrrxsAdapter;
  tasks: TaskStore;
}

export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | Record<string, unknown>
  >;
  isError?: boolean;
}

export function textResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

