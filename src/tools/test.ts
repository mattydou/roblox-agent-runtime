import { normalizeResult } from '../runtime/result-normalizer.js';
import type { RuntimeLogCollection } from '../chrrxs/adapter.js';
import type { TestInput } from './schemas.js';
import type { ToolContext, ToolResult } from './context.js';
import { textResult } from './context.js';
import type { TaskEvidence } from '../runtime/task-store.js';

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
  if (input.mode === 'solo' && input.action === 'begin_session') {
    const report = await context.managedRuntime.begin({ instance_id: input.instance_id, play_mode: input.play_mode, required_roles: input.required_roles });
    await context.tasks.recordEvidence({ tool: 'roblox_test', operation: 'evidence_session_begin', category: 'lifecycle', source: 'runtime', summary: `evidence session ${report.session.id} ${report.session.status}`, success: report.success });
    return { ...textResult(report, !report.success), telemetry: { evidence_session_event: 'begin', managed_playtest_started: report.lifecycle.transitions.includes('playtest_started') ? 1 : 0, managed_playtest_reused: report.lifecycle.transitions.some((item) => item.includes('reused')) ? 1 : 0, managed_artifacts_created: report.session.roles.length } };
  }
  if (input.mode === 'solo' && input.action === 'session_status') {
    try {
      const report = await context.managedRuntime.status(input.session_id!);
      return textResult(report, !report.success);
    } catch {
      return textResult({ success: false, error_code: 'UNKNOWN_TEST_SESSION', session_id: input.session_id }, true);
    }
  }
  if (input.mode === 'solo' && input.action === 'run_batch') {
    const value = await context.managedRuntime.runBatch(input.session_id!, input.batch!, input.refresh_stale);
    const passed = value.report.success && value.report.assertions.length > 0 && value.report.assertions.every((item) => item.passed === true);
    const category = taskEvidenceCategory(value.report);
    await context.tasks.recordEvidence({ tool: 'roblox_test', operation: 'evidence_batch', category, source: 'runtime', summary: `${value.report.assertions.filter((item) => item.passed === true).length}/${value.report.assertions.length} objective assertions passed`, success: category === 'behavior' ? passed : value.report.success }, passed ? 'behavioral_test' : undefined);
    const result: ToolResult = { content: [{ type: 'text', text: JSON.stringify(value.report) }, ...value.images], ...(value.report.success ? {} : { isError: true }) };
    result.telemetry = thisReportTelemetry('batch', value.report);
    return result;
  }
  if (input.mode === 'solo' && input.action === 'finish_session') {
    const report = await context.managedRuntime.finish(input.session_id!);
    await context.tasks.recordEvidence({ tool: 'roblox_test', operation: 'evidence_session_cleanup', category: 'cleanup', source: 'runtime', summary: `managed cleanup ${report.success ? 'verified' : 'partial'}`, success: report.success }, report.success ? 'cleanup' : undefined);
    return { ...textResult(report, !report.success), telemetry: thisReportTelemetry('end', report) };
  }
  if (input.mode === 'solo' && input.action === 'run_scenario') {
    const value = await context.managedRuntime.scenario({ instance_id: input.instance_id, play_mode: input.play_mode, batch: input.batch!, required_roles: input.required_roles });
    const passed = value.report.success && value.report.assertions.length > 0 && value.report.assertions.every((item) => item.passed === true);
    const category = taskEvidenceCategory(value.report);
    await context.tasks.recordEvidence({ tool: 'roblox_test', operation: 'evidence_scenario', category, source: 'runtime', summary: `${value.report.assertions.filter((item) => item.passed === true).length}/${value.report.assertions.length} objective assertions passed`, success: category === 'behavior' ? passed : value.report.success }, passed ? 'behavioral_test' : undefined);
    const result: ToolResult = { content: [{ type: 'text', text: JSON.stringify(value.report) }, ...value.images], ...(value.report.success ? {} : { isError: true }), telemetry: thisReportTelemetry('scenario', value.report) };
    return result;
  }
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
    context.managedRuntime.noteCallerLifecycleStart(input.instance_id, discovered.length ? discovered : fallbackTargets(input));
  } else if (input.action !== 'stop' && discovered.length) {
    context.chrrxs.updateRuntimeLogSession(input.instance_id, discovered);
  }

  if (input.action !== 'stop' && shouldCollect) logs = await collectLogs(input, context);
  if (input.action === 'stop') { context.chrrxs.endRuntimeLogSession(input.instance_id); context.managedRuntime.noteLifecycleStop(input.instance_id); }

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
    category: 'lifecycle', source: 'runtime',
    summary: `${input.mode} ${input.action}; ${runtimeErrors.length} new error-like log entries`, success: true,
  }, input.action === 'start' ? 'playtest' : undefined);
  return textResult(result);
}

function taskEvidenceCategory(report: { failure_kind?: string; failure?: { category?: string }; assertions: unknown[] }): NonNullable<TaskEvidence['category']> {
  if (report.failure_kind === 'infrastructure' || report.failure_kind === 'stale') return 'infrastructure';
  if (report.assertions.length) return 'behavior';
  if (report.failure?.category === 'readiness' || report.failure?.category === 'setup' || report.failure?.category === 'interaction') return report.failure.category;
  return 'observation';
}

function thisReportTelemetry(event: string, report: { actions: unknown[]; observations: unknown[]; watches: unknown[]; series: unknown[]; assertions: Array<Record<string, unknown>>; runtime_errors: unknown[]; lifecycle: { transitions: string[] }; cleanup: Record<string, unknown> }): Record<string, unknown> {
  const harnesses = report.cleanup.harnesses && typeof report.cleanup.harnesses === 'object' ? report.cleanup.harnesses as Record<string, unknown> : {};
  return {
    evidence_session_event: event,
    action_count: report.actions.length,
    probe_count: report.observations.reduce<number>((total, item) => total + (Array.isArray((item as Record<string, unknown>).probes) ? ((item as Record<string, unknown>).probes as unknown[]).length : 0), 0),
    watch_count: report.watches.length,
    assertion_count: report.assertions.length,
    assertion_failures: report.assertions.filter((item) => item.passed !== true).length,
    sampling_count: report.series.length,
    sampling_truncated: report.series.filter((item) => Boolean((item as Record<string, unknown>).truncated)).length,
    runtime_error_count: report.runtime_errors.length,
    managed_playtest_stops: report.lifecycle.transitions.filter((item) => item.includes('stopped')).length,
    revision_stale: (report as Record<string, unknown>).error_code === 'TEST_SESSION_STALE',
    managed_artifacts_cleaned: Array.isArray(harnesses.cleaned) ? harnesses.cleaned.length : 0,
    managed_artifacts_remaining: Array.isArray(harnesses.remaining) ? harnesses.remaining.length : 0,
  };
}
