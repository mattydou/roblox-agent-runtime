import { describe, expect, it } from 'vitest';
import { normalizeResult, selectProperties } from '../src/runtime/result-normalizer.js';

describe('result normalizer', () => {
  it('bounds arrays, strings, keys, and base64 without mutating input', () => {
    const input = { data: 'a'.repeat(2_000), entries: [1, 2, 3, 4], text: 'z'.repeat(20) };
    const output = normalizeResult(input, { maxArray: 2, maxString: 10 }) as Record<string, unknown>;
    expect(output.data).toBe('[2000 base64 chars omitted]');
    expect(output.entries).toEqual([1, 2, '[2 items omitted]']);
    expect(output.text).toContain('chars omitted');
    expect(input.data).toHaveLength(2_000);
  });

  it('filters a property bag deterministically', () => {
    expect(selectProperties({ properties: { Name: 'P', Size: 4 } }, ['Name'])).toEqual({ properties: { Name: 'P' } });
  });
});

