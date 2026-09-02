import { z } from 'zod';

export const taskStepSchema = z.object({
  id: z.string().min(1).max(80),
  description: z.string().min(1).max(1_000),
  status: z.enum(['pending', 'in_progress', 'completed']).default('pending'),
}).strict();

export const taskRequirementSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.string().min(1).max(80),
  description: z.string().max(1_000).optional(),
  status: z.enum(['pending', 'completed']).default('pending'),
  evidence: z.string().max(2_000).optional(),
}).strict();

export const taskInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('begin'),
    task_id: z.string().min(1).max(80).optional(),
    goal: z.string().min(1).max(10_000),
    plan: z.array(taskStepSchema).max(100).optional(),
    requirements: z.array(taskRequirementSchema).max(100).optional(),
    enforcement: z.enum(['advisory', 'enforced']).default('advisory'),
  }).strict(),
  z.object({
    action: z.literal('set_plan'),
    plan: z.array(taskStepSchema).max(100).optional(),
    requirements: z.array(taskRequirementSchema).max(100).optional(),
  }).strict().refine((value) => value.plan !== undefined || value.requirements !== undefined, 'plan or requirements is required'),
  z.object({
    action: z.literal('mark_step'),
    step_id: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
  }).strict(),
  z.object({ action: z.literal('record_observation'), text: z.string().min(1).max(20_000) }).strict(),
  z.object({
    action: z.literal('record_validation'),
    name: z.string().min(1).max(200),
    success: z.boolean(),
    details: z.string().max(20_000).optional(),
    requirement_id: z.string().min(1).optional(),
  }).strict(),
  z.object({ action: z.literal('status'), detail: z.enum(['compact', 'full']).default('compact') }).strict(),
  z.object({ action: z.literal('complete'), detail: z.enum(['compact', 'full']).default('compact') }).strict(),
]);

const instanceId = z.string().min(1).optional();
const maxResults = z.number().int().min(1).max(500).default(50);
const inspectionContext = z.string().regex(/^(edit|server|client-[1-9][0-9]*)$/, 'context must be edit, server, or client-N').default('edit');
const controlledContext = z.enum(['edit', 'client-1']).default('edit');

export const inspectInputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('status'), include_place_info: z.boolean().default(true), instance_id: instanceId }).strict(),
  z.object({
    mode: z.literal('hierarchy'), path: z.string().optional(), depth: z.number().int().min(0).max(12).default(3),
    scripts_only: z.boolean().default(false), max_results: maxResults, context: inspectionContext, instance_id: instanceId,
  }).strict(),
  z.object({
    mode: z.literal('search'), query: z.string().min(1), search_by: z.enum(['name', 'class', 'property', 'content']).default('name'),
    property_name: z.string().optional(), max_results: maxResults, context: inspectionContext, instance_id: instanceId,
  }).strict().superRefine((value, issue) => {
    if (value.search_by === 'property' && !value.property_name) issue.addIssue({ code: 'custom', path: ['property_name'], message: 'property_name is required for property search' });
    if (value.context !== 'edit' && !['name', 'class'].includes(value.search_by)) issue.addIssue({ code: 'custom', path: ['search_by'], message: 'runtime contexts support name or class search only' });
  }),
  z.object({
    mode: z.literal('properties'), path: z.string().min(1), exclude_source: z.boolean().default(true),
    properties: z.array(z.string().min(1)).min(1).max(100).optional(), context: inspectionContext, instance_id: instanceId,
  }).strict().superRefine((value, issue) => {
    if (value.context !== 'edit' && !value.properties?.length) issue.addIssue({ code: 'custom', path: ['properties'], message: 'selected properties are required in runtime contexts' });
  }),
  z.object({
    mode: z.literal('scripts'), query: z.string().optional(), path: z.string().optional(), depth: z.number().int().min(0).max(12).default(6),
    max_results: maxResults, instance_id: instanceId,
  }).strict(),
  z.object({ mode: z.literal('script_source'), path: z.string().min(1), line_range: z.string().optional(), instance_id: instanceId }).strict(),
  z.object({ mode: z.literal('selection'), instance_id: instanceId }).strict(),
  z.object({
    mode: z.literal('gui'), context: controlledContext, path: z.string().min(1).max(500),
    depth: z.number().int().min(0).max(8).default(4), max_results: z.number().int().min(1).max(200).default(50),
    interactive_only: z.boolean().default(false), instance_id: instanceId,
  }).strict(),
  z.object({
    mode: z.literal('runtime'), target: z.string().default('edit'), since: z.number().int().min(0).optional(),
    tail: z.number().int().min(1).max(500).default(100), filter: z.string().optional(), instance_id: instanceId,
  }).strict(),
]);

const finite = z.number().finite();
const vector2Value = z.object({ type: z.literal('Vector2'), x: finite, y: finite }).strict();
const vector3Value = z.object({ type: z.literal('Vector3'), x: finite, y: finite, z: finite }).strict();
const color3Value = z.object({ type: z.literal('Color3'), r: finite.min(0).max(1), g: finite.min(0).max(1), b: finite.min(0).max(1) }).strict();
const color3RgbValue = z.object({ type: z.literal('Color3RGB'), r: finite.min(0).max(255), g: finite.min(0).max(255), b: finite.min(0).max(255) }).strict();
const taggedPropertyValueSchema = z.discriminatedUnion('type', [
  vector2Value,
  vector3Value,
  color3Value,
  color3RgbValue,
  z.object({
    type: z.literal('CFrame'), position: z.tuple([finite, finite, finite]).optional(),
    rotation_degrees: z.tuple([finite, finite, finite]).optional(), rotationDegrees: z.tuple([finite, finite, finite]).optional(),
    components: z.array(finite).length(12).optional(),
  }).strict().refine((value) => !value.components || (!value.position && !value.rotation_degrees && !value.rotationDegrees), 'components cannot be combined with position/rotation'),
  z.object({ type: z.literal('UDim'), scale: finite, offset: finite }).strict(),
  z.object({
    type: z.literal('UDim2'), x: z.tuple([finite, finite]).optional(), y: z.tuple([finite, finite]).optional(),
    xScale: finite.optional(), xOffset: finite.optional(), yScale: finite.optional(), yOffset: finite.optional(),
  }).strict().refine((value) => (value.x && value.y) || [value.xScale, value.xOffset, value.yScale, value.yOffset].every((item) => item !== undefined), 'UDim2 needs x/y tuples or all four named components'),
  z.object({ type: z.literal('Enum'), enum: z.string().min(1), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal('BrickColor'), name: z.string().min(1).optional(), number: z.number().int().positive().optional() }).strict()
    .refine((value) => value.name !== undefined || value.number !== undefined, 'BrickColor needs name or number'),
  z.object({ type: z.literal('NumberRange'), min: finite, max: finite.optional() }).strict(),
  z.object({ type: z.literal('NumberSequence'), keypoints: z.array(z.object({ time: finite.min(0).max(1), value: finite, envelope: finite.nonnegative().optional() }).strict()).min(2).max(100) }).strict(),
  z.object({ type: z.literal('ColorSequence'), keypoints: z.array(z.object({ time: finite.min(0).max(1), color: z.union([color3Value, color3RgbValue]) }).strict()).min(2).max(100) }).strict(),
  z.object({ type: z.literal('Rect'), min: vector2Value, max: vector2Value }).strict(),
  z.object({ type: z.literal('Ray'), origin: vector3Value, direction: vector3Value }).strict(),
  z.object({
    type: z.literal('PhysicalProperties'), density: finite.positive(), friction: finite.nonnegative(), elasticity: finite.nonnegative(),
    frictionWeight: finite.nonnegative(), elasticityWeight: finite.nonnegative(),
  }).strict(),
  z.object({ type: z.literal('Instance'), path: z.string().min(1) }).strict(),
]);
export const propertyValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), finite, z.boolean(), z.null(), z.array(propertyValueSchema).max(10_000), taggedPropertyValueSchema,
]));
const propertyMap = z.record(z.string().min(1), propertyValueSchema);
const reference = z.string().min(1).describe('Canonical Studio path or an earlier create operation reference such as $projectile');

export const editOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'), id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(), class_name: z.string().min(1),
    parent: reference, name: z.string().min(1).optional(), properties: propertyMap.optional(), source: z.string().optional(),
  }).strict(),
  z.object({ op: z.literal('modify'), target: reference, properties: propertyMap.optional(), attributes: propertyMap.optional() }).strict()
    .refine((value) => value.properties !== undefined || value.attributes !== undefined, 'properties or attributes is required'),
  z.object({ op: z.literal('move'), target: reference, parent: reference }).strict(),
  z.object({ op: z.literal('rename'), target: reference, name: z.string().min(1) }).strict(),
  z.object({ op: z.literal('delete'), target: reference }).strict(),
  z.object({ op: z.literal('replace_script_source'), target: reference, source: z.string() }).strict(),
  z.object({ op: z.literal('patch_script'), target: reference, old_text: z.string().min(1), new_text: z.string() }).strict(),
]);

const structuredEditInputSchema = z.object({
  operations: z.array(editOperationSchema).min(1).max(100),
  continue_on_error: z.boolean().default(false),
  instance_id: instanceId,
}).strict();

const editLuauInputSchema = z.object({
  source: z.string().min(1).max(50_000),
  timeout_ms: z.number().int().min(1_000).max(30_000).default(30_000),
  instance_id: instanceId,
}).strict();

export const editInputSchema = z.union([structuredEditInputSchema, editLuauInputSchema]);

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const poseSchema = z.object({
  joint: z.string().min(1).describe('Motor/constraint name, animated Part name, or canonical path returned by operation="inspect_rig" for the authoritative target rig'),
  position: vec3.default([0, 0, 0]),
  rotation_degrees: vec3.default([0, 0, 0]),
  easing_style: z.enum(['Linear', 'Constant', 'Elastic', 'Cubic', 'Bounce', 'CubicV2']).default('Linear'),
  easing_direction: z.enum(['In', 'Out', 'InOut']).default('InOut'),
}).strict();

export const markerSchema = z.object({ name: z.string().min(1), value: z.string().default('') }).strict();
export const keyframeSchema = z.object({
  time: z.number().finite().min(0),
  name: z.string().min(1).optional(),
  poses: z.array(poseSchema).min(1).max(300),
  markers: z.array(markerSchema).max(100).default([]),
}).strict();

export const animationDefinitionSchema = z.object({
  target_rig: z.string().min(1).describe('Authoritative existing rig Model; it is inspected and never replaced or reconstructed'),
  name: z.string().min(1).max(100),
  duration: z.number().finite().positive().optional(),
  loop: z.boolean().default(false),
  priority: z.enum(['Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4', 'Core']).default('Action'),
  keyframes: z.array(keyframeSchema).min(1).max(500),
  preview: z.enum(['none', 'register', 'play']).default('none'),
  replace_existing: z.boolean().default(false),
}).strict();

const inspectAnimationRigInputSchema = z.object({
  kind: z.literal('animation'),
  operation: z.literal('inspect_rig'),
  target_rig: z.string().min(1).describe('Authoritative existing rig Model to inspect without modifying it'),
  instance_id: instanceId,
}).strict();

const createAnimationInputSchema = z.object({
  kind: z.literal('animation'),
  operation: z.literal('create').default('create'),
  animation: animationDefinitionSchema,
  observation: z.object({
    samples: z.array(z.union([
      z.object({ time: z.number().finite().min(0).max(30) }).strict(),
      z.object({ marker: z.string().min(1) }).strict(),
    ])).min(1).max(3),
    continue_playback: z.boolean().default(false),
    context: z.enum(['edit', 'playtest']).default('playtest'),
    format: z.enum(['jpeg', 'png']).default('jpeg'),
    quality: z.number().int().min(1).max(100).default(92),
  }).strict().optional(),
  instance_id: instanceId,
}).strict();

const acquireAnimationFixtureInputSchema = z.object({
  kind: z.literal('animation'),
  operation: z.literal('acquire_fixture'),
  fixture: z.object({
    rig_type: z.enum(['R6', 'R15']),
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/).optional(),
    position: vec3.default([0, 3, 0]),
  }).strict(),
  instance_id: instanceId,
}).strict();

const cleanupAnimationFixtureInputSchema = z.object({
  kind: z.literal('animation'),
  operation: z.literal('cleanup_fixture'),
  target_rig: z.string().min(1),
  artifact_names: z.array(z.string().min(1).max(100)).max(20).default([]),
  instance_id: instanceId,
}).strict();

const fixtureDefinitionSchema = z.object({
  rig_type: z.enum(['R6', 'R15']),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/).optional(),
  position: vec3.default([0, 3, 0]),
}).strict();
const acquireFixtureInputSchema = z.object({
  kind: z.literal('fixture'), operation: z.literal('acquire'), fixture: fixtureDefinitionSchema, instance_id: instanceId,
}).strict();
const inspectFixtureInputSchema = z.object({
  kind: z.literal('fixture'), operation: z.literal('inspect'), target_rig: z.string().min(1), instance_id: instanceId,
}).strict();
const cleanupFixtureInputSchema = z.object({
  kind: z.literal('fixture'), operation: z.literal('cleanup'), target_rig: z.string().min(1),
  artifact_names: z.array(z.string().min(1).max(100)).max(20).default([]), instance_id: instanceId,
}).strict();

export const authorInputSchema = z.union([
  inspectAnimationRigInputSchema, createAnimationInputSchema, acquireAnimationFixtureInputSchema, cleanupAnimationFixtureInputSchema,
  acquireFixtureInputSchema, inspectFixtureInputSchema, cleanupFixtureInputSchema,
]);

const evidenceId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const evidenceContext = z.string().regex(/^(server|client-[1-9][0-9]*)$/, 'context must be server or client-N');
const evidenceClientContext = z.string().regex(/^client-[1-9][0-9]*$/, 'input target must be client-N');
const evidencePath = z.string().min(1).max(500);
const actionTimeout = z.number().int().min(50).max(30_000).default(5_000);
const pollInterval = z.number().int().min(25).max(1_000).default(100);
const requiredRolesSchema = z.array(z.enum(['server', 'client-1'])).min(1).max(2).refine((roles) => new Set(roles).size === roles.length, 'required_roles must not contain duplicates');
const probeSchema = z.discriminatedUnion('kind', [
  z.object({ id: evidenceId, kind: z.literal('exists'), context: evidenceContext, path: evidencePath }).strict(),
  z.object({ id: evidenceId, kind: z.literal('property'), context: evidenceContext, path: evidencePath, property: z.string().min(1).max(100) }).strict(),
  z.object({
    id: evidenceId, kind: z.literal('descendant_count'), context: evidenceContext, path: evidencePath,
    name: z.string().min(1).max(100).optional(), class_name: z.string().min(1).max(100).optional(),
  }).strict(),
]);
const watchSchema = z.discriminatedUnion('kind', [
  z.object({
    id: evidenceId, kind: z.literal('instance_lifecycle'), context: evidenceContext, path: evidencePath,
    name: z.string().min(1).max(100).optional(), class_name: z.string().min(1).max(100).optional(),
  }).strict(),
  z.object({ id: evidenceId, kind: z.literal('signal'), context: evidenceContext, path: evidencePath, signal: z.string().min(1).max(100) }).strict(),
  z.object({ id: evidenceId, kind: z.literal('property_change'), context: evidenceContext, path: evidencePath, property: z.string().min(1).max(100) }).strict(),
]);
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ id: evidenceId.optional(), kind: z.literal('wait'), duration_ms: z.number().int().min(0).max(5_000) }).strict(),
  z.object({
    id: evidenceId.optional(), kind: z.literal('keyboard'), target: evidenceClientContext.default('client-1'), key_code: z.string().min(1).max(60),
    action: z.enum(['press', 'release', 'tap']).default('tap'), duration_ms: z.number().int().min(10).max(2_000).default(100),
  }).strict(),
  z.object({
    id: evidenceId.optional(), kind: z.literal('mouse'), target: evidenceClientContext.default('client-1'),
    action: z.enum(['click', 'down', 'up']).default('click'), x: z.number().int().min(0).max(20_000),
    y: z.number().int().min(0).max(20_000), button: z.enum(['Left', 'Right', 'Middle']).default('Left'),
  }).strict(),
  z.object({
    id: evidenceId.optional(), kind: z.literal('tool'), context: evidenceContext.default('client-1'),
    operation: z.enum(['equip', 'activate', 'unequip']), target: z.string().min(1).max(500).optional(), player: z.string().min(1).max(100).optional(),
    auto_equip: z.boolean().default(true), timeout_ms: actionTimeout, poll_interval_ms: pollInterval,
  }).strict().superRefine((value, issue) => {
    if (value.operation !== 'unequip' && !value.target) issue.addIssue({ code: 'custom', path: ['target'], message: 'target is required for equip/activate' });
    if (value.context === 'server' && !value.player) issue.addIssue({ code: 'custom', path: ['player'], message: 'player is required for server Tool actions' });
  }),
  z.object({
    id: evidenceId.optional(), kind: z.literal('wait_for'), context: z.enum(['server', 'client-1']),
    condition: z.enum(['path_exists', 'player_available', 'character_available', 'character_ready', 'backpack_available', 'tool_available', 'tool_equipped', 'gui_available', 'interaction_available']),
    path: evidencePath.optional(), player: z.string().min(1).max(100).optional(), tool: evidencePath.optional(),
    interaction: z.enum(['proximity_prompt', 'click_detector', 'gui_button']).optional(), timeout_ms: actionTimeout, poll_interval_ms: pollInterval,
  }).strict().superRefine((value, issue) => {
    if (value.condition === 'path_exists' && !value.path) issue.addIssue({ code: 'custom', path: ['path'], message: 'path is required for path_exists' });
    if (['tool_available', 'tool_equipped'].includes(value.condition) && !value.tool) issue.addIssue({ code: 'custom', path: ['tool'], message: 'tool is required for Tool readiness' });
    if (value.condition === 'gui_available' && !value.path) issue.addIssue({ code: 'custom', path: ['path'], message: 'path is required for gui_available' });
    if (value.condition === 'interaction_available' && (!value.path || !value.interaction)) issue.addIssue({ code: 'custom', path: ['interaction'], message: 'path and interaction are required for interaction_available' });
    if (value.context === 'server' && value.condition !== 'path_exists' && !value.player) issue.addIssue({ code: 'custom', path: ['player'], message: 'player is required for server player readiness' });
  }),
  z.object({
    id: evidenceId.optional(), kind: z.literal('position'), context: z.enum(['server', 'client-1']).default('server'),
    subject: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('path'), path: evidencePath }).strict(),
      z.object({ kind: z.literal('character'), player: z.string().min(1).max(100).optional() }).strict(),
    ]),
    destination: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('position'), position: vec3 }).strict(),
      z.object({ kind: z.literal('path'), path: evidencePath }).strict(),
      z.object({ kind: z.literal('character'), player: z.string().min(1).max(100).optional() }).strict(),
    ]),
    offset: vec3.default([0, 0, 0]), offset_space: z.enum(['world', 'anchor']).default('world'),
    orientation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('preserve') }).strict(),
      z.object({ kind: z.literal('yaw'), degrees: z.number().finite().min(-360).max(360) }).strict(),
      z.object({ kind: z.literal('face_path'), path: evidencePath }).strict(),
      z.object({ kind: z.literal('face_position'), position: vec3 }).strict(),
    ]).default({ kind: 'preserve' }), timeout_ms: actionTimeout,
    tolerance: z.number().finite().min(0.001).max(100).default(0.05),
  }).strict().superRefine((value, issue) => {
    if (value.context === 'server' && value.subject.kind === 'character' && !value.subject.player) issue.addIssue({ code: 'custom', path: ['subject', 'player'], message: 'server Character subject requires player' });
    if (value.context === 'server' && value.destination.kind === 'character' && !value.destination.player) issue.addIssue({ code: 'custom', path: ['destination', 'player'], message: 'server Character destination requires player' });
  }),
  z.object({
    id: evidenceId.optional(), kind: z.literal('interaction'), context: z.literal('client-1').default('client-1'),
    interaction: z.enum(['proximity_prompt', 'click_detector', 'gui_button']), path: evidencePath,
    button: z.enum(['Left', 'Right']).default('Left'), timeout_ms: actionTimeout, poll_interval_ms: pollInterval,
  }).strict(),
  z.object({
    id: evidenceId.optional(), kind: z.literal('screenshot'), format: z.enum(['jpeg', 'png']).default('jpeg'),
    quality: z.number().int().min(1).max(100).default(80),
  }).strict(),
  z.object({
    id: evidenceId, kind: z.literal('luau'), role: z.enum(['server', 'client-1']), source: z.string().min(1).max(50_000),
    timeout_ms: z.number().int().min(1_000).max(30_000).default(10_000),
  }).strict(),
]);
const seriesSchema = z.object({
  id: evidenceId,
  probe: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('exists'), context: evidenceContext, path: evidencePath }).strict(),
    z.object({ kind: z.literal('property'), context: evidenceContext, path: evidencePath, property: z.string().min(1).max(100) }).strict(),
    z.object({
      kind: z.literal('descendant_count'), context: evidenceContext, path: evidencePath,
      name: z.string().min(1).max(100).optional(), class_name: z.string().min(1).max(100).optional(),
    }).strict(),
  ]),
  interval_ms: z.number().int().min(50).max(2_000),
  duration_ms: z.number().int().min(50).max(10_000),
  label: z.string().max(100).optional(),
}).strict().superRefine((value, issue) => {
  if (Math.floor(value.duration_ms / value.interval_ms) + 1 > 100) issue.addIssue({ code: 'custom', path: ['interval_ms'], message: 'series may contain at most 100 samples' });
});
const assertionSchema = z.object({
  id: evidenceId,
  evidence: evidenceId,
  condition: z.enum([
    'equals', 'not_equals', 'exists', 'absent', 'unchanged', 'changed', 'exact_count', 'minimum_count', 'maximum_count',
    'exact_numeric_delta', 'minimum_numeric_delta', 'maximum_numeric_delta', 'zero_occurrences', 'at_least_one_occurrence',
  ]),
  expected: z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()]).optional(),
  tolerance: z.number().finite().min(0).max(1_000_000).default(0),
}).strict();
const checkpointSchema = z.object({
  id: evidenceId, phase: z.enum(['before', 'after']).default('after'), probes: z.array(probeSchema).min(1).max(20),
}).strict();
export const evidenceBatchSchema = z.object({
  actions: z.array(actionSchema).max(20).default([]),
  watches: z.array(watchSchema).max(8).default([]),
  series: z.array(seriesSchema).max(4).default([]),
  checkpoints: z.array(checkpointSchema).max(10).default([]),
  assertions: z.array(assertionSchema).max(20).default([]),
  deadline_ms: z.number().int().min(1_000).max(60_000).default(30_000),
  continue_on_failure: z.boolean().default(false),
}).strict().superRefine((value, issue) => {
  const wait = value.actions.reduce((total, action) => total + (action.kind === 'wait' ? action.duration_ms : 0), 0);
  if (wait > 10_000) issue.addIssue({ code: 'custom', path: ['actions'], message: 'cumulative explicit wait may not exceed 10000ms' });
  const probes = value.checkpoints.flatMap((checkpoint) => checkpoint.probes);
  if (probes.length > 50) issue.addIssue({ code: 'custom', path: ['checkpoints'], message: 'a batch may contain at most 50 probes' });
  const producedIds = [...value.actions.filter((item) => item.id), ...value.watches, ...value.series, ...probes].map((item) => item.id!);
  const ids = [...producedIds, ...value.checkpoints.map((item) => item.id), ...value.assertions.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) issue.addIssue({ code: 'custom', path: [], message: 'evidence IDs must be unique within a batch' });
  for (const [index, assertion] of value.assertions.entries()) {
    if (!producedIds.includes(assertion.evidence)) issue.addIssue({ code: 'custom', path: ['assertions', index, 'evidence'], message: 'assertion must reference evidence produced by this batch' });
    if (['equals', 'not_equals', 'exact_count', 'minimum_count', 'maximum_count', 'exact_numeric_delta', 'minimum_numeric_delta', 'maximum_numeric_delta'].includes(assertion.condition) && assertion.expected === undefined) {
      issue.addIssue({ code: 'custom', path: ['assertions', index, 'expected'], message: 'expected is required for this condition' });
    }
    if (['exact_count', 'minimum_count', 'maximum_count', 'exact_numeric_delta', 'minimum_numeric_delta', 'maximum_numeric_delta'].includes(assertion.condition) && typeof assertion.expected !== 'number') {
      issue.addIssue({ code: 'custom', path: ['assertions', index, 'expected'], message: 'expected must be numeric for this condition' });
    }
  }
});

export const testInputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('solo'), action: z.enum(['start', 'status', 'stop', 'begin_session', 'run_batch', 'finish_session', 'session_status', 'run_scenario']),
    play_mode: z.enum(['play', 'run']).default('play'), session_id: z.string().uuid().optional(), batch: evidenceBatchSchema.optional(),
    required_roles: requiredRolesSchema.optional(),
    refresh_stale: z.boolean().default(false),
    collect_logs: z.boolean().optional(), log_tail: z.number().int().min(1).max(500).default(100),
    log_timeout_ms: z.number().int().min(100).max(10_000).default(3_000), timeout_seconds: z.number().min(1).max(180).optional(),
    instance_id: instanceId,
  }).strict().superRefine((value, issue) => {
    if (['run_batch', 'finish_session', 'session_status'].includes(value.action) && !value.session_id) issue.addIssue({ code: 'custom', path: ['session_id'], message: 'session_id is required for this action' });
    if (['run_batch', 'run_scenario'].includes(value.action) && !value.batch) issue.addIssue({ code: 'custom', path: ['batch'], message: 'batch is required for this action' });
  }),
  z.object({
    mode: z.literal('multiplayer'), action: z.enum(['start', 'status', 'add_players', 'leave_client', 'stop']),
    players: z.number().int().min(1).max(8).optional(), target: z.string().optional(), collect_logs: z.boolean().optional(),
    log_tail: z.number().int().min(1).max(500).default(100), log_timeout_ms: z.number().int().min(100).max(10_000).default(3_000),
    timeout_seconds: z.number().min(1).max(180).optional(), instance_id: instanceId,
  }).strict(),
]);

export const observeInputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('screenshot'), format: z.enum(['jpeg', 'png']).default('jpeg'), quality: z.number().int().min(1).max(100).default(92),
    instance_id: instanceId,
  }).strict(),
  z.object({
    mode: z.literal('logs'), target: z.string().default('edit'), since: z.number().int().min(0).optional(),
    tail: z.number().int().min(1).max(500).default(100), filter: z.string().optional(), instance_id: instanceId,
  }).strict(),
  z.object({
    mode: z.literal('state'), path: z.string().min(1), properties: z.array(z.string().min(1)).min(1).max(100).optional(),
    context: inspectionContext, instance_id: instanceId,
  }).strict().superRefine((value, issue) => {
    if (value.context !== 'edit' && !value.properties?.length) issue.addIssue({ code: 'custom', path: ['properties'], message: 'selected properties are required in runtime contexts' });
  }),
  z.object({
    mode: z.literal('views'), context: controlledContext,
    target_path: z.string().min(1).max(500).optional(), center: vec3.optional(),
    radius: z.number().finite().positive().max(1_000_000).optional(), padding: z.number().finite().positive().max(10).default(1),
    basis: z.enum(['target', 'world']).default('target'),
    views: z.array(z.union([
      z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(), preset: z.enum(['front', 'rear', 'left', 'right', 'overhead', 'front_right', 'front_left', 'rear_right', 'rear_left', 'lower_front']) }).strict(),
      z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(), azimuth: z.number().finite().min(-360).max(360), elevation: z.number().finite().min(-89.5).max(89.5) }).strict(),
    ])).min(1).max(6),
    field_of_view: z.number().finite().min(1).max(120).default(70), restore_viewport: z.boolean().default(true),
    settle_frames: z.number().int().min(1).max(10).default(2), settle_timeout_ms: z.number().int().min(100).max(5_000).default(1_500),
    format: z.enum(['jpeg', 'png']).default('jpeg'), quality: z.number().int().min(1).max(100).default(85), instance_id: instanceId,
  }).strict().superRefine((value, issue) => {
    if (Boolean(value.target_path) === Boolean(value.center)) issue.addIssue({ code: 'custom', path: ['target_path'], message: 'exactly one of target_path or center is required' });
    if (value.center && value.radius === undefined) issue.addIssue({ code: 'custom', path: ['radius'], message: 'radius is required with center' });
    if (value.center && value.basis !== 'world') issue.addIssue({ code: 'custom', path: ['basis'], message: 'center targets require basis=world' });
    if (value.format === 'png' && value.views.length > 2) issue.addIssue({ code: 'custom', path: ['views'], message: 'PNG controlled capture is limited to two views' });
    const ids = value.views.map((view, index) => view.id ?? ('preset' in view ? view.preset : `view-${index + 1}`));
    if (new Set(ids).size !== ids.length) issue.addIssue({ code: 'custom', path: ['views'], message: 'view IDs must be unique' });
  }),
]);

export type TaskInput = z.infer<typeof taskInputSchema>;
export type InspectInput = z.infer<typeof inspectInputSchema>;
export type EditInput = z.infer<typeof editInputSchema>;
export type EditOperation = z.infer<typeof editOperationSchema>;
export type AnimationDefinition = z.infer<typeof animationDefinitionSchema>;
export type EvidenceBatch = z.infer<typeof evidenceBatchSchema>;
export type EvidenceAction = EvidenceBatch['actions'][number];
export type EvidenceProbe = EvidenceBatch['checkpoints'][number]['probes'][number];
export type EvidenceWatch = EvidenceBatch['watches'][number];
export type EvidenceSeries = EvidenceBatch['series'][number];
export type EvidenceAssertion = EvidenceBatch['assertions'][number];
export type AuthorInput = z.infer<typeof authorInputSchema>;
export type TestInput = z.infer<typeof testInputSchema>;
export type ObserveInput = z.infer<typeof observeInputSchema>;
