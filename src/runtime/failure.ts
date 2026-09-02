export type FailureCategory = 'validation' | 'infrastructure' | 'readiness' | 'setup' | 'interaction' | 'assertion' | 'stale' | 'cleanup' | 'observation';
export type Retryability = 'yes' | 'no' | 'unknown';

export interface StructuredFailure {
  category: FailureCategory;
  code: string;
  stage: string;
  summary: string;
  last_successful_checkpoint?: string;
  expected?: unknown;
  observed?: unknown;
  deadline_ms?: number;
  elapsed_ms?: number;
  retryable: Retryability;
  diagnostics?: Record<string, unknown>;
}

function bounded(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 1_000);
  if (Array.isArray(value)) return value.slice(0, 20).map(bounded);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, item]) => [key, bounded(item)]));
}

export function failure(input: Omit<StructuredFailure, 'retryable' | 'diagnostics'> & {
  retryable?: Retryability;
  diagnostics?: Record<string, unknown>;
}): StructuredFailure {
  return {
    ...input,
    summary: input.summary.slice(0, 1_000),
    retryable: input.retryable ?? 'unknown',
    ...(input.diagnostics ? { diagnostics: bounded(input.diagnostics) as Record<string, unknown> } : {}),
  };
}

export function failureKind(category: FailureCategory): 'behavioral' | 'infrastructure' | 'stale' {
  if (category === 'stale') return 'stale';
  if (category === 'infrastructure' || category === 'cleanup') return 'infrastructure';
  return 'behavioral';
}
