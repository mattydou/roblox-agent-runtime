import { describe, expect, it } from 'vitest';
import { compileEditBatch } from '../src/edit/compiler.js';
import { editInputSchema } from '../src/tools/schemas.js';
import { longBracket } from '../src/runtime/luau.js';

describe('edit compiler', () => {
  it('encodes model input as JSON data and supports batch references', () => {
    const payload = editInputSchema.parse({ operations: [
      { op: 'create', id: 'folder', class_name: 'Folder', parent: 'game.Workspace', name: 'A"]] tricky' },
      { op: 'create', class_name: 'Part', parent: '$folder', properties: { Size: { type: 'Vector3', x: 1, y: 2, z: 3 } } },
    ] });
    const source = compileEditBatch(payload);
    expect(source).toContain('JSONDecode');
    expect(source).toContain('unknown batch reference');
    expect(source).toContain('NumberSequenceKeypoint');
    expect(source).toContain('[=[{"operations"');
  });

  it('selects a safe long-bracket delimiter', () => {
    expect(longBracket('a]]b')).toBe('[=[a]]b]=]');
  });
});
