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

export const editInputSchema = z.object({
  operations: z.array(editOperationSchema).min(1).max(100),
  continue_on_error: z.boolean().default(false),
  instance_id: instanceId,
}).strict();

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
  preview: z.enum(['register', 'play']).default('register'),
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
    context: z.enum(['edit', 'playtest']).default('edit'),
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

export const authorInputSchema = z.union([
  inspectAnimationRigInputSchema, createAnimationInputSchema, acquireAnimationFixtureInputSchema, cleanupAnimationFixtureInputSchema,
]);

export const testInputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('solo'), action: z.enum(['start', 'status', 'stop']), play_mode: z.enum(['play', 'run']).default('play'),
    collect_logs: z.boolean().optional(), log_tail: z.number().int().min(1).max(500).default(100),
    log_timeout_ms: z.number().int().min(100).max(10_000).default(3_000), timeout_seconds: z.number().min(1).max(180).optional(),
    instance_id: instanceId,
  }).strict(),
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
]);

export type TaskInput = z.infer<typeof taskInputSchema>;
export type InspectInput = z.infer<typeof inspectInputSchema>;
export type EditInput = z.infer<typeof editInputSchema>;
export type EditOperation = z.infer<typeof editOperationSchema>;
export type AnimationDefinition = z.infer<typeof animationDefinitionSchema>;
export type AuthorInput = z.infer<typeof authorInputSchema>;
export type TestInput = z.infer<typeof testInputSchema>;
export type ObserveInput = z.infer<typeof observeInputSchema>;
