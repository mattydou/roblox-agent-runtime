export interface PublicToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type Schema = Record<string, unknown>;

const string = (description?: string, maxLength?: number): Schema => ({ type: 'string', ...(maxLength ? { maxLength } : {}), ...(description ? { description } : {}) });
const enumeration = (values: string[], description?: string): Schema => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
const integer = (minimum: number, maximum: number, description?: string): Schema => ({ type: 'integer', minimum, maximum, ...(description ? { description } : {}) });
const array = (items: Schema, maxItems: number, description?: string): Schema => ({ type: 'array', items, maxItems, ...(description ? { description } : {}) });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

const taggedValue = object({
  type: enumeration(['Vector2', 'Vector3', 'Color3', 'Color3RGB', 'CFrame', 'UDim', 'UDim2', 'Enum', 'BrickColor', 'NumberRange', 'NumberSequence', 'ColorSequence', 'Rect', 'Ray', 'PhysicalProperties', 'Instance']),
  x: {}, y: {}, r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' }, position: { type: 'array' }, rotation_degrees: { type: 'array' }, components: { type: 'array' },
  enum: string(), value: {}, name: string(), number: { type: 'integer' }, min: {}, max: {}, keypoints: { type: 'array' }, path: string(),
});
const propertyMap: Schema = { type: 'object', description: 'Property map. Scalars are direct; Roblox values use a typed object such as {type:"Vector3",x:0,y:4,z:0}. Supported tags include PhysicalProperties.', additionalProperties: { anyOf: [{ type: ['string', 'number', 'boolean', 'null'] }, taggedValue] } };
const operation = object({
  op: enumeration(['create', 'modify', 'move', 'rename', 'delete', 'replace_script_source', 'patch_script']), id: string(), class_name: string(), parent: string(), target: string(), name: string(), properties: propertyMap, attributes: propertyMap, source: string(), old_text: string(), new_text: string(),
}, ['op']);

const action = object({
  id: string('Evidence id; required for Luau and when an assertion references this action.'), kind: enumeration(['wait', 'wait_for', 'keyboard', 'mouse', 'tool', 'position', 'interaction', 'screenshot', 'luau']),
  role: enumeration(['server', 'client-1'], 'Fixed execution role for kind=luau.'), source: string('Caller Luau for kind=luau; max 50,000 bytes.', 50_000), timeout_ms: integer(1_000, 30_000),
  duration_ms: integer(0, 5_000), target: string(), context: enumeration(['server', 'client-1']), key_code: string(), action: string(), x: { type: 'integer' }, y: { type: 'integer' }, button: enumeration(['Left', 'Right', 'Middle']),
  operation: enumeration(['equip', 'activate', 'unequip']), player: string(), auto_equip: { type: 'boolean' }, condition: string(), path: string(), tool: string(), interaction: enumeration(['proximity_prompt', 'click_detector', 'gui_button']), poll_interval_ms: integer(25, 1_000),
  subject: { type: 'object' }, destination: { type: 'object' }, offset: { type: 'array' }, offset_space: enumeration(['world', 'anchor']), orientation: { type: 'object' }, tolerance: { type: 'number' }, format: enumeration(['jpeg', 'png']), quality: integer(1, 100),
}, ['kind']);
const probe = object({ id: string(), kind: enumeration(['exists', 'property', 'descendant_count']), context: enumeration(['server', 'client-1']), path: string(), property: string(), name: string(), class_name: string() }, ['id', 'kind', 'context', 'path']);
const watch = object({ id: string(), kind: enumeration(['instance_lifecycle', 'signal', 'property_change']), context: enumeration(['server', 'client-1']), path: string(), signal: string(), property: string(), name: string(), class_name: string() }, ['id', 'kind', 'context', 'path']);
const assertion = object({ id: string(), evidence: string(), condition: enumeration(['equals', 'not_equals', 'exists', 'absent', 'changed', 'unchanged', 'exact_count', 'minimum_count', 'maximum_count', 'exact_numeric_delta', 'minimum_numeric_delta', 'maximum_numeric_delta', 'zero_occurrences', 'at_least_one_occurrence']), expected: {}, tolerance: { type: 'number' } }, ['id', 'evidence', 'condition']);
const batch = object({
  actions: array(action, 20), watches: array(watch, 8), series: array(object({ id: string(), probe, interval_ms: integer(50, 2_000), duration_ms: integer(50, 10_000), label: string() }, ['id', 'probe', 'interval_ms', 'duration_ms']), 4),
  checkpoints: array(object({ id: string(), phase: enumeration(['before', 'after']), probes: array(probe, 20) }, ['id', 'probes']), 10), assertions: array(assertion, 20), deadline_ms: integer(1_000, 60_000), continue_on_failure: { type: 'boolean' },
});

const schemas: Record<string, Schema> = {
  roblox_task: object({ action: enumeration(['begin', 'set_plan', 'mark_step', 'record_observation', 'record_validation', 'status', 'complete']), task_id: string(), goal: string(undefined, 10_000), plan: { type: 'array' }, requirements: { type: 'array' }, enforcement: enumeration(['advisory', 'enforced']), step_id: string(), status: enumeration(['pending', 'in_progress', 'completed']), text: string(), name: string(), success: { type: 'boolean' }, details: string(), requirement_id: string(), detail: enumeration(['compact', 'full']) }, ['action']),
  roblox_inspect: object({ mode: enumeration(['status', 'hierarchy', 'search', 'properties', 'scripts', 'script_source', 'selection', 'gui', 'runtime']), context: enumeration(['edit', 'server', 'client-1']), path: string(), depth: integer(0, 12), scripts_only: { type: 'boolean' }, max_results: integer(1, 500), query: string(), search_by: enumeration(['name', 'class', 'property', 'content']), property_name: string(), exclude_source: { type: 'boolean' }, properties: array(string(), 100), line_range: string(), interactive_only: { type: 'boolean' }, include_place_info: { type: 'boolean' }, target: string(), since: { type: 'integer' }, tail: integer(1, 500), filter: string(), instance_id: string() }, ['mode']),
  roblox_edit: { ...object({ operations: array(operation, 100, 'Structured path for small precise edits; legacy V3 calls remain valid.'), continue_on_error: { type: 'boolean' }, source: string('Edit-context Luau for repetitive construction, loops, cloning, and templates; max 50,000 bytes. Mutations may be partial on error.', 50_000), timeout_ms: integer(1_000, 30_000), instance_id: string() }), description: 'Exactly one of operations or source is accepted by strict handler validation.' },
  roblox_author: object({ kind: enumeration(['animation', 'fixture']), operation: enumeration(['inspect_rig', 'create', 'acquire_fixture', 'cleanup_fixture', 'acquire', 'inspect', 'cleanup']), target_rig: string('Authoritative existing rig; never reconstructed or substituted.'), fixture: object({ rig_type: enumeration(['R6', 'R15']), name: string(), position: { type: 'array', minItems: 3, maxItems: 3 } }), animation: object({ target_rig: string(), name: string(), duration: { type: 'number' }, loop: { type: 'boolean' }, priority: string(), preview: enumeration(['none', 'register', 'play']), replace_existing: { type: 'boolean' }, keyframes: { type: 'array', description: 'Keyframes with time, poses, and markers; pose joints use canonical references from inspect_rig.' } }), observation: object({ samples: { type: 'array', maxItems: 3 }, continue_playback: { type: 'boolean' }, context: enumeration(['edit', 'playtest']), format: enumeration(['jpeg', 'png']), quality: integer(1, 100) }), artifact_names: array(string(), 20), instance_id: string() }, ['kind']),
  roblox_test: object({ mode: enumeration(['solo', 'multiplayer']), action: enumeration(['run_scenario', 'begin_session', 'run_batch', 'finish_session', 'session_status', 'start', 'status', 'stop', 'add_players', 'leave_client']), play_mode: enumeration(['play', 'run']), session_id: string(), batch, required_roles: array(enumeration(['server', 'client-1']), 2), refresh_stale: { type: 'boolean' }, collect_logs: { type: 'boolean' }, log_tail: integer(1, 500), log_timeout_ms: integer(100, 10_000), timeout_seconds: { type: 'number' }, players: integer(1, 8), target: string(), instance_id: string() }, ['mode', 'action']),
  roblox_observe: object({ mode: enumeration(['screenshot', 'views', 'logs', 'state']), context: enumeration(['edit', 'client-1', 'server']), path: string(), properties: array(string(), 100), target: string(), since: { type: 'integer' }, tail: integer(1, 500), filter: string(), target_path: string(), center: { type: 'array', minItems: 3, maxItems: 3 }, radius: { type: 'number' }, basis: enumeration(['target', 'world']), views: { type: 'array', minItems: 1, maxItems: 6, items: object({ preset: enumeration(['front', 'rear', 'left', 'right', 'overhead', 'front_left', 'front_right', 'rear_left', 'rear_right']), id: string(), azimuth: { type: 'number' }, elevation: { type: 'number' }, distance_scale: { type: 'number' } }) }, fov_degrees: { type: 'number' }, format: enumeration(['jpeg', 'png']), quality: integer(1, 100), instance_id: string() }, ['mode']),
};

const descriptions: Record<string, string> = {
  roblox_task: 'Optional persistent state for multi-session work, enforcement, recovery, or handoff. Short single-session work should use zero task calls and must not manually advance a task. When a task is already active, edits, authoring, tests, and observations record evidence automatically. Compatible V3 task inputs and migration remain accepted.',
  roblox_inspect: 'Bounded Studio reads. Prefer edit-mode hierarchy/properties and static GUI facts when Play is unnecessary; use client-1 GUI inspection for actual runtime bounds and visibility. Runtime logs are incremental and role-aware.',
  roblox_edit: 'Persistent edits with two first-class paths. Use structured operations for small precise existing-place changes, typed properties, and guarded script patches. Use edit-context Luau for repetitive greenfield construction, loops, cloning, templates, or configuration that would require many JSON mutations. Luau is bounded but may partially mutate before failure, is never retried, and always stales managed sessions after an execution attempt.',
  roblox_author: 'Rig-authoritative native animation and marked R6/R15 fixture ownership. inspect_rig derives actual Motor6D topology; never reconstruct or substitute the caller rig. Animation artifacts remain separate from managed preview. Fixtures support animation and generic gameplay tests, and cleanup refuses unmarked rigs.',
  roblox_test: 'For short work, use one run_scenario first: it acquires Play, waits only for required prerequisites, mixes input/interactions with bounded server or client-1 Luau, objective probes/watches/series/assertions, a player-view screenshot and incremental logs, then releases input and owned state. Use begin/run/finish only for multiple batches. Runtime code runs only in a ready managed role, is never retried, and caller-owned Play is never stopped.',
  roblox_observe: 'Visual evidence without persistent edits. Use controlled edit-mode views for world composition and spatial review; use a roblox_test runtime screenshot for first-person/client presentation, runtime GUI, or animation during Play. Prefer one high-value view and skip visual calls when there is no visual acceptance criterion. Images are returned directly; the runtime does not judge aesthetics. Controlled views restore the camera in finally and do not advance revision.',
};

const examples: Record<string, unknown[]> = {
  roblox_task: [{ action: 'status', detail: 'compact' }],
  roblox_inspect: [{ mode: 'properties', context: 'edit', path: 'game.Workspace.Door', properties: ['Anchored', 'CFrame'] }],
  roblox_edit: [{ operations: [{ op: 'modify', target: 'game.Workspace.Door', properties: { Anchored: true } }] }, { source: 'local root = Instance.new("Folder")\nroot.Name = "Generated"\nroot.Parent = workspace\nfor i = 1, 8 do\n  local part = Instance.new("Part")\n  part.Name = `Part{i}`\n  part.Position = Vector3.new(i * 4, 2, 0)\n  part.Parent = root\nend\nreturn {created = 8, root = root}', timeout_ms: 15_000 }],
  roblox_author: [{ kind: 'animation', operation: 'inspect_rig', target_rig: 'game.Workspace.Rig' }],
  roblox_test: [
    { mode: 'solo', action: 'run_scenario', required_roles: ['server', 'client-1'], batch: { actions: [{ id: 'serverFact', kind: 'luau', role: 'server', source: 'return workspace:GetAttribute("SmokeState")' }, { kind: 'keyboard', target: 'client-1', key_code: 'E', action: 'press' }, { kind: 'wait', duration_ms: 150 }, { kind: 'screenshot' }, { kind: 'keyboard', target: 'client-1', key_code: 'E', action: 'release' }], assertions: [{ id: 'stateCheck', evidence: 'serverFact', condition: 'equals', expected: 'ready' }] } },
    { mode: 'solo', action: 'begin_session', required_roles: ['server', 'client-1'] },
    { mode: 'solo', action: 'run_batch', session_id: '00000000-0000-4000-8000-000000000000', batch: { actions: [{ kind: 'wait', duration_ms: 100 }] } },
    { mode: 'solo', action: 'finish_session', session_id: '00000000-0000-4000-8000-000000000000' },
  ],
  roblox_observe: [{ mode: 'views', context: 'edit', target_path: 'game.Workspace.AuthoredSet', views: [{ preset: 'front_right' }] }],
};

export const PUBLIC_TOOLS: PublicToolDefinition[] = ['roblox_task', 'roblox_inspect', 'roblox_edit', 'roblox_author', 'roblox_test', 'roblox_observe'].map((name) => ({ name, description: descriptions[name]!, inputSchema: { ...schemas[name]!, examples: examples[name] } }));
