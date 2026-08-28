export interface NormalizeOptions {
  maxDepth?: number;
  maxArray?: number;
  maxString?: number;
  maxKeys?: number;
}

const DEFAULTS: Required<NormalizeOptions> = {
  maxDepth: 8,
  maxArray: 50,
  maxString: 4_000,
  maxKeys: 80,
};

export function parseTextJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function normalizeResult(value: unknown, options: NormalizeOptions = {}): unknown {
  const limits = { ...DEFAULTS, ...options };
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === 'string') {
      if (current.length <= limits.maxString) return current;
      return `${current.slice(0, limits.maxString)}…[${current.length - limits.maxString} chars omitted]`;
    }
    if (current === null || typeof current !== 'object') return current;
    if (depth >= limits.maxDepth) return '[max depth reached]';
    if (seen.has(current)) return '[circular]';
    seen.add(current);

    if (Array.isArray(current)) {
      const output = current.slice(0, limits.maxArray).map((item) => visit(item, depth + 1));
      if (current.length > limits.maxArray) {
        output.push(`[${current.length - limits.maxArray} items omitted]`);
      }
      return output;
    }

    const entries = Object.entries(current as Record<string, unknown>);
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, limits.maxKeys)) {
      if ((key === 'data' || key === 'base64') && typeof item === 'string' && item.length > 1_000) {
        output[key] = `[${item.length} base64 chars omitted]`;
      } else {
        output[key] = visit(item, depth + 1);
      }
    }
    if (entries.length > limits.maxKeys) {
      output._omitted_keys = entries.length - limits.maxKeys;
    }
    return output;
  };

  return visit(value, 0);
}

export function selectProperties(value: unknown, properties?: string[]): unknown {
  if (!properties?.length || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const propertyBag = source.properties;
  if (!propertyBag || typeof propertyBag !== 'object' || Array.isArray(propertyBag)) return value;
  const wanted = new Set(properties);
  const filtered = Object.fromEntries(
    Object.entries(propertyBag as Record<string, unknown>).filter(([key]) => wanted.has(key)),
  );
  return { ...source, properties: filtered };
}

