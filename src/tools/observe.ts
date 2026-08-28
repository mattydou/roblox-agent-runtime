import { normalizeResult, selectProperties } from '../runtime/result-normalizer.js';
import type { ObserveInput } from './schemas.js';
import type { ToolContext, ToolResult } from './context.js';
import { textResult } from './context.js';
import { compileRuntimeInspection, parseExecuteResult } from '../runtime/luau.js';

export async function handleObserve(input: ObserveInput, context: ToolContext): Promise<ToolResult> {
  const instance = input.instance_id ? { instance_id: input.instance_id } : {};
  if (input.mode === 'screenshot') {
    const result = await context.chrrxs.call('capture_screenshot', {
      format: input.format,
      quality: input.quality,
      ...instance,
    }, 120_000);
    const hasImage = result.content.some((block) => block.type === 'image');
    if (!hasImage) throw new Error('Chrrxs screenshot returned no MCP image content');
    await context.tasks.recordEvidence({
      tool: 'roblox_observe', operation: 'screenshot', summary: 'captured a viewport screenshot', success: true,
    }, 'screenshot');
    return result as ToolResult;
  }
  if (input.mode === 'logs') {
    const value = await context.chrrxs.collectRuntimeLogs({
      targets: input.target === 'all' ? undefined : [input.target],
      tail: input.tail,
      since: input.since,
      ...(input.filter ? { filter: input.filter } : {}),
      instance_id: input.instance_id,
    });
    return textResult(normalizeResult(value, { maxArray: input.tail }));
  }
  if (input.context !== 'edit') {
    if (!input.properties?.length) throw new Error('properties is required for bounded runtime state observation');
    const tool = input.context === 'server' ? 'eval_server_runtime' : 'eval_client_runtime';
    const raw = await context.chrrxs.callJson(tool, {
      code: compileRuntimeInspection({ mode: 'properties', path: input.path, properties: input.properties }),
      ...(input.context.startsWith('client-') ? { target: input.context } : {}),
      ...instance,
    }, 10_000);
    const parsed = parseExecuteResult(raw) as Record<string, unknown>;
    return textResult({ context: input.context, result: parsed.result });
  }
  const value = await context.chrrxs.callJson('get_instance_properties', {
    instancePath: input.path,
    excludeSource: true,
    ...instance,
  });
  return textResult(normalizeResult(selectProperties(value, input.properties)));
}
