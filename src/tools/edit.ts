import { compileEditBatch } from '../edit/compiler.js';
import { normalizeResult } from '../runtime/result-normalizer.js';
import { CALLER_LUAU_SOURCE_MAX_BYTES, compileCallerLuau, parseExecuteResult } from '../runtime/luau.js';
import { failure } from '../runtime/failure.js';
import type { EditInput } from './schemas.js';
import type { ToolContext, ToolResult } from './context.js';
import { textResult } from './context.js';

export async function handleEdit(input: EditInput, context: ToolContext): Promise<ToolResult> {
  if ('source' in input) {
    if (Buffer.byteLength(input.source, 'utf8') > CALLER_LUAU_SOURCE_MAX_BYTES) {
      const structured = failure({ category: 'validation', code: 'LUAU_SOURCE_TOO_LARGE', stage: 'edit Luau validation', summary: `Edit Luau exceeds the ${CALLER_LUAU_SOURCE_MAX_BYTES}-byte source limit.`, observed: { source_bytes: Buffer.byteLength(input.source, 'utf8') }, expected: { maximum_bytes: CALLER_LUAU_SOURCE_MAX_BYTES }, retryable: 'no' });
      return textResult({ success: false, error_code: structured.code, failure_kind: 'validation', failure: structured }, true);
    }
    let persistentRevision: string | undefined;
    try {
      persistentRevision = context.managedRuntime.notePersistentMutation('roblox_edit_luau');
      const raw = await context.chrrxs.callJson('execute_luau', {
        code: compileCallerLuau(input.source), target: 'edit', ...(input.instance_id ? { instance_id: input.instance_id } : {}),
      }, input.timeout_ms);
      const parsed = parseExecuteResult(raw) as Record<string, unknown>;
      const successful = parsed.success === true;
      await context.tasks.recordEvidence({
        tool: 'roblox_edit', operation: 'luau', category: 'implementation', source: 'runtime',
        summary: successful ? 'bounded edit Luau completed' : 'bounded edit Luau failed; persistent mutation may be partial', success: successful,
      });
      const code = typeof parsed.error_code === 'string' ? parsed.error_code : 'CALLER_LUAU_FAILED';
      const structured = successful ? undefined : failure({
        category: 'interaction', code, stage: 'edit Luau execution',
        summary: 'Edit Luau reported failure after execution began; persistent mutation may be partial.',
        observed: Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'value')), retryable: 'no',
      });
      const result = normalizeResult({
        ...parsed,
        execution_context: 'edit',
        persistent_revision: persistentRevision,
        partial_mutation_possible: !successful,
        retry_performed: false,
        ...(structured ? { failure_kind: 'behavioral', failure: structured } : {}),
      });
      return textResult(result, !successful);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      const structured = failure({
        category: 'infrastructure', code: 'EDIT_LUAU_EXECUTION_AMBIGUOUS', stage: 'edit Luau execution',
        summary: 'Edit Luau did not produce a trustworthy completion result; persistent mutation may be partial.',
        observed: { message }, retryable: 'no',
      });
      await context.tasks.recordEvidence({
        tool: 'roblox_edit', operation: 'luau', category: 'infrastructure', source: 'runtime',
        summary: 'edit Luau completion was ambiguous; persistent mutation may be partial', success: false,
      });
      return textResult({ success: false, error_code: structured.code, failure_kind: 'infrastructure', failure: structured, execution_context: 'edit', persistent_revision: persistentRevision, partial_mutation_possible: true, retry_performed: false }, true);
    }
  }
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
    category: 'implementation', source: 'runtime',
    summary: `${completed}/${input.operations.length} edit operations completed`,
    success: successful,
  });
  if (completed > 0) context.managedRuntime.notePersistentMutation('roblox_edit');
  return textResult(normalizeResult(result, { maxArray: 100 }), !successful);
}
