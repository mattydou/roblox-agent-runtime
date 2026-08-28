import type { ZodType } from 'zod';
import type { ChrrxsAdapter } from '../chrrxs/adapter.js';
import { approximateBytes, Telemetry } from './telemetry.js';
import { TaskStore } from './task-store.js';
import { PUBLIC_TOOLS } from '../tools/definitions.js';
import {
  authorInputSchema,
  editInputSchema,
  inspectInputSchema,
  observeInputSchema,
  taskInputSchema,
  testInputSchema,
} from '../tools/schemas.js';
import { handleTask } from '../tools/task.js';
import { handleInspect } from '../tools/inspect.js';
import { handleEdit } from '../tools/edit.js';
import { handleAuthor } from '../tools/author.js';
import { handleTest } from '../tools/test.js';
import { handleObserve } from '../tools/observe.js';
import type { ToolResult } from '../tools/context.js';
import { textResult } from '../tools/context.js';

type Handler = (input: never, context: { chrrxs: ChrrxsAdapter; tasks: TaskStore }) => Promise<ToolResult>;

const SCHEMAS: Record<string, ZodType> = {
  roblox_task: taskInputSchema,
  roblox_inspect: inspectInputSchema,
  roblox_edit: editInputSchema,
  roblox_author: authorInputSchema,
  roblox_test: testInputSchema,
  roblox_observe: observeInputSchema,
};

const HANDLERS: Record<string, Handler> = {
  roblox_task: handleTask as Handler,
  roblox_inspect: handleInspect as Handler,
  roblox_edit: handleEdit as Handler,
  roblox_author: handleAuthor as Handler,
  roblox_test: handleTest as Handler,
  roblox_observe: handleObserve as Handler,
};

export class RobloxAgentRuntime {
  readonly tasks: TaskStore;

  constructor(
    readonly chrrxs: ChrrxsAdapter,
    readonly telemetry: Telemetry,
    runtimeDir: string,
  ) {
    this.tasks = new TaskStore(runtimeDir);
  }

  listTools() {
    return PUBLIC_TOOLS;
  }

  async dispatch(name: string, args: unknown): Promise<ToolResult> {
    const schema = SCHEMAS[name];
    const handler = HANDLERS[name];
    const operation = this.operation(args);
    const started = performance.now();
    let result: ToolResult;
    let success = false;
    let taskId = await this.tasks.currentId();
    try {
      if (!schema || !handler) throw new Error(`unknown public tool: ${name}`);
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        result = textResult({
          error: 'invalid_arguments',
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        }, true);
      } else {
        result = await handler(parsed.data as never, { chrrxs: this.chrrxs, tasks: this.tasks });
      }
      success = result.isError !== true;
    } catch (error) {
      result = textResult({
        error: 'tool_failed',
        message: error instanceof Error ? error.message : String(error),
      }, true);
    }
    taskId = (await this.tasks.currentId()) ?? taskId;
    await this.telemetry.model({
      timestamp: new Date().toISOString(),
      task_id: taskId,
      public_tool: name,
      public_operation: operation,
      duration_ms: Math.round((performance.now() - started) * 100) / 100,
      request_bytes: approximateBytes(args),
      response_bytes: approximateBytes(result),
      success,
    });
    return result;
  }

  private operation(args: unknown): string {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return 'unknown';
    const record = args as Record<string, unknown>;
    if (typeof record.action === 'string') return record.action;
    if (typeof record.mode === 'string') return record.mode;
    if (typeof record.kind === 'string') return record.kind;
    return 'call';
  }
}

