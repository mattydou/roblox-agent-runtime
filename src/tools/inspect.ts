import { normalizeResult } from '../runtime/result-normalizer.js';
import type { InspectInput } from './schemas.js';
import type { ToolContext, ToolResult } from './context.js';
import { textResult } from './context.js';
import { compileRuntimeInspection, parseExecuteResult, type RuntimeInspectionRequest } from '../runtime/luau.js';

function withInstance(input: { instance_id?: string }): Record<string, unknown> {
  return input.instance_id ? { instance_id: input.instance_id } : {};
}

export async function handleInspect(input: InspectInput, context: ToolContext): Promise<ToolResult> {
  if ('context' in input && input.context !== 'edit') {
    if (!['hierarchy', 'search', 'properties'].includes(input.mode)) {
      throw new Error(`mode=${input.mode} is not supported in runtime context=${input.context}; use hierarchy, search, or properties`);
    }
    let request: RuntimeInspectionRequest;
    if (input.mode === 'hierarchy') request = { mode: 'hierarchy', path: input.path, depth: input.depth, scripts_only: input.scripts_only, max_results: input.max_results };
    else if (input.mode === 'search') {
      if (input.search_by !== 'name' && input.search_by !== 'class') throw new Error(`search_by=${input.search_by} is not supported in runtime contexts; use name or class`);
      request = { mode: 'search', query: input.query, search_by: input.search_by, max_results: input.max_results };
    } else {
      if (!input.properties?.length) throw new Error('properties is required for bounded runtime property inspection');
      request = { mode: 'properties', path: input.path, properties: input.properties };
    }
    const tool = input.context === 'server' ? 'eval_server_runtime' : 'eval_client_runtime';
    const raw = await context.chrrxs.callJson(tool, {
      code: compileRuntimeInspection(request),
      ...(input.context.startsWith('client-') ? { target: input.context } : {}),
      ...withInstance(input),
    }, 10_000);
    const parsed = parseExecuteResult(raw) as Record<string, unknown>;
    return textResult({ context: input.context, result: parsed.result });
  }
  let value: unknown;
  let limit = 50;
  switch (input.mode) {
    case 'status': {
      const instances = await context.chrrxs.callJson('get_connected_instances');
      const place = input.include_place_info
        ? await context.chrrxs.callJson('get_place_info', withInstance(input))
        : undefined;
      value = { instances, ...(place === undefined ? {} : { place }) };
      break;
    }
    case 'hierarchy':
      limit = input.max_results;
      value = await context.chrrxs.callJson('get_project_structure', {
        ...(input.path ? { path: input.path } : {}),
        maxDepth: input.depth,
        scriptsOnly: input.scripts_only,
        ...withInstance(input),
      });
      break;
    case 'search': {
      limit = input.max_results;
      if (input.search_by === 'content') {
        value = await context.chrrxs.callJson('grep_scripts', {
          pattern: input.query,
          maxResults: input.max_results,
          ...withInstance(input),
        });
      } else {
        if (input.search_by === 'property' && !input.property_name) {
          throw new Error('property_name is required when search_by="property"');
        }
        value = await context.chrrxs.callJson('search_objects', {
          query: input.query,
          searchType: input.search_by,
          ...(input.property_name ? { propertyName: input.property_name } : {}),
          ...withInstance(input),
        });
      }
      break;
    }
    case 'properties':
      value = await context.chrrxs.callJson('get_instance_properties', {
        instancePath: input.path,
        excludeSource: input.exclude_source,
        ...withInstance(input),
      });
      break;
    case 'scripts':
      limit = input.max_results;
      value = input.query
        ? await context.chrrxs.callJson('grep_scripts', {
          pattern: input.query,
          path: input.path,
          maxResults: input.max_results,
          ...withInstance(input),
        })
        : await context.chrrxs.callJson('get_project_structure', {
          path: input.path,
          maxDepth: input.depth,
          scriptsOnly: true,
          ...withInstance(input),
        });
      break;
    case 'script_source':
      value = await context.chrrxs.callJson('get_script_source', {
        instancePath: input.path,
        ...(input.line_range ? { line_range: input.line_range } : {}),
        ...withInstance(input),
      });
      break;
    case 'selection':
      value = await context.chrrxs.callJson('selection', { action: 'get', ...withInstance(input) });
      break;
    case 'runtime':
      limit = input.tail;
      value = await context.chrrxs.collectRuntimeLogs({
        targets: input.target === 'all' ? undefined : [input.target],
        tail: input.tail,
        since: input.since,
        ...(input.filter ? { filter: input.filter } : {}),
        instance_id: input.instance_id,
      });
      break;
  }
  return textResult(normalizeResult(value, { maxArray: limit }));
}
