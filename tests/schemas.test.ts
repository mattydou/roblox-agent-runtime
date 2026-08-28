import { describe, expect, it } from 'vitest';
import { PUBLIC_TOOLS } from '../src/tools/definitions.js';
import { authorInputSchema, editInputSchema, inspectInputSchema, taskInputSchema } from '../src/tools/schemas.js';

describe('public schemas', () => {
  it('exposes exactly six named tools', () => {
    expect(PUBLIC_TOOLS.map((tool) => tool.name)).toEqual([
      'roblox_task', 'roblox_inspect', 'roblox_edit', 'roblox_author', 'roblox_test', 'roblox_observe',
    ]);
  });

  it('gives Cursor a useful flat root contract for every public tool', () => {
    const expected: Record<string, string[]> = {
      roblox_task: ['action', 'goal', 'detail', 'enforcement'],
      roblox_inspect: ['mode', 'context', 'path', 'query', 'properties'],
      roblox_edit: ['operations', 'continue_on_error'],
      roblox_author: ['kind', 'operation', 'target_rig', 'fixture', 'animation', 'observation'],
      roblox_test: ['mode', 'action', 'collect_logs', 'log_timeout_ms'],
      roblox_observe: ['mode', 'context', 'path', 'properties'],
    };
    for (const tool of PUBLIC_TOOLS) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.inputSchema).not.toHaveProperty('oneOf');
      expect(tool.inputSchema).not.toHaveProperty('anyOf');
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(properties).length, tool.name).toBeGreaterThan(0);
      expect(Object.keys(properties), tool.name).toEqual(expect.arrayContaining(expected[tool.name]!));
    }
    const authorProperties = PUBLIC_TOOLS.find((tool) => tool.name === 'roblox_author')!.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(authorProperties.operation.enum).toEqual(expect.arrayContaining(['inspect_rig', 'create', 'acquire_fixture', 'cleanup_fixture']));
  });

  it('validates edit batches before Studio', () => {
    expect(editInputSchema.safeParse({ operations: [] }).success).toBe(false);
    expect(editInputSchema.safeParse({
      operations: [{ op: 'create', id: 'part', class_name: 'Part', parent: 'game.Workspace', properties: { Anchored: true } }],
    }).success).toBe(true);
    expect(editInputSchema.safeParse({ operations: [{
      op: 'modify', target: 'game.Workspace.Part', properties: { Color: { type: 'MadeUp', value: 1 } },
    }] }).success).toBe(false);
    const editPublic = PUBLIC_TOOLS.find((tool) => tool.name === 'roblox_edit')!;
    expect(JSON.stringify(editPublic.inputSchema)).toContain('PhysicalProperties');
  });

  it('requires property_name for property search in the handler-facing shape', () => {
    const parsed = inspectInputSchema.safeParse({ mode: 'search', query: 'x', search_by: 'property' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['property_name']);
  });

  it('keeps strict conditional validation behind the flat descriptions', () => {
    expect(taskInputSchema.safeParse({ action: 'begin', goal: 'x', step_id: 'wrong-branch' }).success).toBe(false);
    expect(inspectInputSchema.safeParse({ mode: 'status', context: 'server' }).success).toBe(false);
    expect(authorInputSchema.safeParse({ kind: 'animation', operation: 'cleanup_fixture', fixture: { rig_type: 'R15' } }).success).toBe(false);
  });

  it('only accepts animation authoring', () => {
    expect(authorInputSchema.safeParse({ kind: 'vfx', vfx: {} }).success).toBe(false);
    expect(authorInputSchema.safeParse({
      kind: 'animation', operation: 'inspect_rig', target_rig: 'game.Workspace.R15Rig',
    }).success).toBe(true);
    expect(authorInputSchema.safeParse({
      kind: 'animation', operation: 'acquire_fixture', fixture: { rig_type: 'R15' },
    }).success).toBe(true);
    const create = authorInputSchema.parse({ kind: 'animation', animation: {
      target_rig: 'game.Workspace.R15Rig', name: 'Wave', keyframes: [{ time: 0, poses: [{ joint: 'RightHand' }] }],
    } });
    expect(create.operation).toBe('create');
  });
});
