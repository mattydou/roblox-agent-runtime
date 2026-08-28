import { normalizeResult } from '../runtime/result-normalizer.js';
import type { RuntimeLogCollection } from '../chrrxs/adapter.js';
import type { TestInput } from './schemas.js';
import type { ToolContext, ToolResult } from './context.js';
import { textResult } from './context.js';

export function findRuntimeErrors(value: unknown): unknown[] {
  const errors: unknown[] = [];
  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) { for (const item of current) visit(item); return; }
    const record = current as Record<string, unknown>;
    const level = String(record.level ?? record.messageType ?? '').toLowerCase();
    const message = String(record.message ?? record.text ?? '');
    if (level.includes('error') || /(^|\W)(error|exception|traceback)(\W|$)/i.test(message)) errors.push(current);
    for (const item of Object.values(record)) visit(item);
  };
  visit(value);
  return errors;
}

function targetsIn(value: unknown): string[] {
  const targets = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string' && /^(edit|server|client-[1-9][0-9]*)$/.test(current)) targets.add(current);
    else if (Array.isArray(current)) for (const item of current) visit(item);
    else if (current && typeof current === 'object') for (const item of Object.values(current as Record<string, unknown>)) visit(item);
  };
  visit(value);
  return [...targets].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function fallbackTargets(input: TestInput): string[] {
  if (input.mode === 'solo') return input.play_mode === 'run' ? ['server'] : ['server', 'client-1'];
  const count = input.players ?? 1;
  return ['server', ...Array.from({ length: count }, (_, index) => `client-${index + 1}`)];
}

async function collectLogs(input: TestInput, context: ToolContext): Promise<RuntimeLogCollection> {
  return context.chrrxs.collectRuntimeLogs({
    instance_id: input.instance_id,
    tail: input.log_tail,
    timeout_ms: input.log_timeout_ms,
  });
}

export async function handleTest(input: TestInput, context: ToolContext): Promise<ToolResult> {
  const instance = input.instance_id ? { instance_id: input.instance_id } : {};
  const shouldCollect = input.collect_logs ?? input.action === 'stop';
  let logs: RuntimeLogCollection | undefined;

  // Final incremental capture must happen while runtime peers still exist.
  if (input.action === 'stop' && shouldCollect) logs = await collectLogs(input, context);

  let lifecycle: unknown;
  if (input.mode === 'solo') {
    lifecycle = await context.chrrxs.callJson('solo_playtest', {
      action: input.action,
      ...(input.action === 'start' ? { mode: input.play_mode } : {}),
      ...(input.timeout_seconds === undefined ? {} : { timeout: input.timeout_seconds }),
      ...instance,
    }, 180_000);
  } else {
    if (['start', 'add_players'].includes(input.action) && input.players === undefined) {
      throw new Error('players is required for multiplayer start/add_players');
    }
    lifecycle = await context.chrrxs.callJson('multiplayer_playtest', {
      action: input.action === 'stop' ? 'end' : input.action,
      ...(input.players === undefined ? {} : { numPlayers: input.players }),
      ...(input.target ? { target: input.target } : {}),
      ...(input.timeout_seconds === undefined ? {} : { timeout: input.timeout_seconds }),
      ...instance,
    }, 180_000);
  }

  const discovered = targetsIn(lifecycle);
  if (input.action === 'start') {
    context.chrrxs.startRuntimeLogSession(input.instance_id, discovered.length ? discovered : fallbackTargets(input));
  } else if (input.action !== 'stop' && discovered.length) {
    context.chrrxs.updateRuntimeLogSession(input.instance_id, discovered);
  }

  if (input.action !== 'stop' && shouldCollect) logs = await collectLogs(input, context);
  if (input.action === 'stop') context.chrrxs.endRuntimeLogSession(input.instance_id);

  const runtimeErrors = findRuntimeErrors(logs?.entries);
  const result = normalizeResult({
    mode: input.mode,
    action: input.action,
    lifecycle,
    runtime_errors: runtimeErrors,
    ...(logs === undefined ? {} : { logs }),
  }, { maxArray: input.log_tail });
  await context.tasks.recordEvidence({
    tool: 'roblox_test', operation: `${input.mode}_${input.action}`,
    summary: `${input.mode} ${input.action}; ${runtimeErrors.length} new error-like log entries`, success: true,
  }, input.action === 'start' ? 'playtest' : undefined);
  return textResult(result);
}
