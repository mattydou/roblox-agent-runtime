import { z } from 'zod';
import {
  authorInputSchema,
  editInputSchema,
  inspectInputSchema,
  observeInputSchema,
  taskInputSchema,
  testInputSchema,
} from './schemas.js';

export interface PublicToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

const FIELD_DESCRIPTIONS: Record<string, Record<string, string>> = {
  roblox_task: {
    action: 'begin, set_plan, mark_step, record_observation, record_validation, status, or complete. Manual bookkeeping actions are optional research controls.',
    detail: 'For status only: compact (default) or full task record.',
    enforcement: 'For begin only: advisory (default) or enforced completion gates.',
  },
  roblox_inspect: {
    mode: 'status, hierarchy, search, properties, scripts, script_source, selection, or runtime logs.',
    context: 'DataModel context: edit (default), server, or a live client-N capture. Runtime contexts support bounded hierarchy/search/properties only.',
    path: 'Canonical path. Runtime examples: game.Workspace or game.Players.PlayerName.Character.',
    query: 'Required for search; literal name/class/content query according to search_by.',
  },
  roblox_author: {
    kind: 'animation (the only V1 authored artifact kind).',
    operation: 'inspect_rig, create, acquire_fixture, or cleanup_fixture. Omission preserves legacy create calls.',
    target_rig: 'Used by inspect_rig/cleanup_fixture; authoritative existing rig path or returned managed fixture path.',
    fixture: 'Used by acquire_fixture: managed Roblox-native R6/R15 avatar settings.',
    animation: 'Used by create: native KeyframeSequence definition against its authoritative target_rig.',
    observation: 'Optional synchronized preview samples for create/observe_preview; maximum three times or markers.',
  },
  roblox_test: {
    mode: 'solo or multiplayer.',
    action: 'Lifecycle action. start/status avoid implicit logs; stop defaults to final bounded incremental collection.',
    collect_logs: 'Optional override. When omitted, only stop collects final incremental logs.',
  },
  roblox_observe: {
    mode: 'screenshot, logs, or state.',
    context: 'For state: edit (default), server, or client-N. Runtime state is read-only and bounded.',
    target: 'For logs: one capture target such as edit, server, or client-1; all is never used implicitly.',
  },
};

const EXAMPLES: Record<string, unknown[]> = {
  roblox_task: [{ action: 'begin', goal: 'Build and test the requested feature' }, { action: 'status', detail: 'compact' }],
  roblox_inspect: [{ mode: 'hierarchy', context: 'server', path: 'game.Workspace', depth: 2, max_results: 50 }],
  roblox_author: [{ kind: 'animation', operation: 'inspect_rig', target_rig: 'game.Workspace.Rig' }],
  roblox_test: [{ mode: 'solo', action: 'stop' }],
  roblox_observe: [{ mode: 'state', context: 'client-1', path: 'game.Workspace.Character', properties: ['Name'] }],
};

function mergeProperty(existing: JsonSchema | undefined, incoming: JsonSchema): JsonSchema {
  if (!existing) return { ...incoming };
  const constants = [existing.const, incoming.const].filter((value) => value !== undefined);
  const enums = [...(Array.isArray(existing.enum) ? existing.enum : []), ...(Array.isArray(incoming.enum) ? incoming.enum : []), ...constants];
  const unique = [...new Set(enums.map((value) => JSON.stringify(value)))].map((value) => JSON.parse(value) as unknown);
  const merged = { ...existing };
  if (unique.length) {
    delete merged.const;
    merged.type = existing.type ?? incoming.type ?? 'string';
    merged.enum = unique;
  }
  return merged;
}

function jsonSchema(name: string, schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
  delete converted.$schema;
  const variants = (converted.oneOf ?? converted.anyOf) as JsonSchema[] | undefined;
  if (!variants) return { ...converted, type: 'object' };

  const properties: Record<string, JsonSchema> = {};
  let commonRequired: Set<string> | undefined;
  for (const variant of variants) {
    const variantProperties = (variant.properties ?? {}) as Record<string, JsonSchema>;
    for (const [propertyName, propertySchema] of Object.entries(variantProperties)) {
      properties[propertyName] = mergeProperty(properties[propertyName], propertySchema);
    }
    const required = new Set(Array.isArray(variant.required) ? variant.required as string[] : []);
    commonRequired = commonRequired === undefined
      ? required
      : new Set([...commonRequired].filter((field) => required.has(field)));
  }
  for (const [field, description] of Object.entries(FIELD_DESCRIPTIONS[name] ?? {})) {
    if (properties[field]) properties[field] = { ...properties[field], description };
  }
  return {
    type: 'object',
    properties,
    ...(commonRequired?.size ? { required: [...commonRequired] } : {}),
    additionalProperties: false,
    ...(EXAMPLES[name] ? { examples: EXAMPLES[name] } : {}),
  };
}

export const PUBLIC_TOOLS: PublicToolDefinition[] = [
  {
    name: 'roblox_task',
    description: 'Optional deterministic persistent research state. Successful edit/author/test/observe operations record evidence automatically. Mutations and status return compact acknowledgements by default; manual step/observation/validation actions remain optional compatibility controls. Advisory tasks may complete with outstanding items, while enforcement="enforced" preserves strict gates.',
    inputSchema: jsonSchema('roblox_task', taskInputSchema),
  },
  {
    name: 'roblox_inspect',
    description: 'Read compact structured information from Roblox Studio. Edit context supports status, hierarchy, search, properties, scripts/source, and selection. Server/client-N contexts safely support bounded hierarchy, literal name/class search, and selected properties through runtime-owned code. Runtime logs are incremental below the model.',
    inputSchema: jsonSchema('roblox_inspect', inspectInputSchema),
  },
  {
    name: 'roblox_edit',
    description: 'Apply an ordered batch of persistent, feature-agnostic Roblox Instance and script edits. Use ordinary Instances for project structure, gameplay objects, VFX, UI, constraints, remotes, and scripts. Prefer one coherent batch with $id references over many microscopic calls. Failures identify completed and failed operations; batches are fail-fast but not transactional.',
    inputSchema: jsonSchema('roblox_edit', editInputSchema),
  },
  {
    name: 'roblox_author',
    description: 'Inspect or author against an authoritative rig without substitution. inspect_rig discovers actual Motor6D/AnimationConstraint topology; create reuses the fingerprinted cache and persists a native KeyframeSequence. acquire_fixture explicitly creates a marked native R6/R15 test rig and cleanup_fixture refuses unmarked rigs. Optional observation captures up to three deterministic time/marker frames in edit or a managed temporary playtest. active:// preview IDs are Studio-session-only; results are not deployment-ready or published.',
    inputSchema: jsonSchema('roblox_author', authorInputSchema),
  },
  {
    name: 'roblox_test',
    description: 'Start, inspect, or stop bounded solo and multiplayer Studio playtests and collect compact relevant logs/errors. Use this after persistent edits, then inspect failures and revise. It wraps lifecycle and evidence collection rather than exposing raw runtime execution.',
    inputSchema: jsonSchema('roblox_test', testInputSchema),
  },
  {
    name: 'roblox_observe',
    description: 'Observe Studio without editing: capture the actual viewport image, read bounded runtime logs/errors, or inspect targeted object state. Screenshot image content is returned directly for model vision critique; this runtime never converts it into an AI-generated description.',
    inputSchema: jsonSchema('roblox_observe', observeInputSchema),
  },
];
