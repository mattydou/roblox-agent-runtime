import { compileEditBatch } from '../edit/compiler.js';
import { normalizeResult } from '../runtime/result-normalizer.js';
import { parseExecuteResult } from '../runtime/luau.js';
import type { EditInput } from './schemas.js';
import type { ToolContext, ToolResult } from './context.js';
import { textResult } from './context.js';

export async function handleEdit(input: EditInput, context: ToolContext): Promise<ToolResult> {
  const raw = await context.chrrxs.callJson('execute_luau', {
    code: compileEditBatch(input),
    target: 'edit',
    ...(input.instance_id ? { instance_id: input.instance_id } : {}),
  }, 120_000);
  const result = parseExecuteResult(raw) as { success?: boolean; results?: unknown[] };
  const successful = result.success === true;
  const completed = Array.isArray(result.results)
    ? result.results.filter((item) => Boolean(item && typeof item === 'object' && (item as Record<string, unknown>).success)).length
    : 0;
  await context.tasks.recordEvidence({
    tool: 'roblox_edit',
    operation: 'batch',
    summary: `${completed}/${input.operations.length} edit operations completed`,
    success: successful,
  });
  return textResult(normalizeResult(result, { maxArray: 100 }), !successful);
}

