import { randomUUID } from 'node:crypto';
import type { ChrrxsAdapter, RuntimeLogCollection } from '../chrrxs/adapter.js';
import type { EvidenceAction, EvidenceAssertion, EvidenceBatch, EvidenceProbe } from '../tools/schemas.js';
import { compileEvidenceHarness } from './evidence-luau.js';
import { CALLER_LUAU_SOURCE_MAX_BYTES, compileCallerLuau, parseExecuteResult } from './luau.js';
import { normalizeResult } from './result-normalizer.js';
import type { Telemetry } from './telemetry.js';
import { failure, failureKind, type StructuredFailure } from './failure.js';

export type SessionStatus = 'ready' | 'stale' | 'ending' | 'cleaned' | 'failed';
export type LifecycleOwnership = 'runtime-owned' | 'caller-owned';

export interface EvidenceSession {
  id: string;
  instance_id?: string;
  revision: number;
  status: SessionStatus;
  ownership: LifecycleOwnership;
  roles: string[];
  required_roles: Array<'server' | 'client-1'>;
  role_health: Record<string, Record<string, unknown>>;
  runtime_state?: Record<string, unknown>;
  play_mode: 'play' | 'run';
  started_at: number;
  refresh_count: number;
  held_keys: Map<string, { target: string; key_code: string }>;
  held_buttons: Map<string, { target: string; x: number; y: number; button: string }>;
  reports: EvidenceReport[];
  managed_artifacts: string[];
  sample_count: number;
  final_report?: EvidenceReport;
}

export interface EvidenceReport {
  success: boolean;
  session: {
    id: string;
    status: SessionStatus;
    instance_id?: string;
    revision: string;
    current_revision: string;
    ownership: LifecycleOwnership | 'unacquired' | 'unknown';
    roles: string[];
    required_roles: string[];
    refresh_count: number;
  };
  lifecycle: { transitions: string[]; owned_stop?: boolean; state?: string; ownership?: string };
  actions: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  watches: Array<Record<string, unknown>>;
  series: Array<Record<string, unknown>>;
  assertions: Array<Record<string, unknown>>;
  runtime_errors: unknown[];
  logs?: unknown;
  cleanup: Record<string, unknown>;
  warnings: string[];
  role_health: Record<string, Record<string, unknown>>;
  runtime_state?: Record<string, unknown>;
  failure_kind?: 'behavioral' | 'infrastructure' | 'stale';
  error_code?: string;
  failure?: StructuredFailure;
  summary?: Record<string, unknown>;
  recommended_next_action?: string;
}

export interface ManagedRuntimeOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface LifecycleRecord {
  revision: number;
  owner: 'runtime' | 'caller';
  owner_session_id?: string;
  roles: string[];
}

interface BatchResult { report: EvidenceReport; images: Array<Record<string, unknown>> }

function instanceKey(instanceId: string | undefined): string { return instanceId ?? '<single>'; }

function targetsIn(value: unknown): string[] {
  const targets = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string' && /^(server|client-[1-9][0-9]*)$/.test(current)) targets.add(current);
    else if (Array.isArray(current)) for (const item of current) visit(item);
    else if (current && typeof current === 'object') for (const item of Object.values(current as Record<string, unknown>)) visit(item);
  };
  visit(value);
  return [...targets].sort((a, b) => a === 'server' ? -1 : b === 'server' ? 1 : a.localeCompare(b, undefined, { numeric: true }));
}

function evidenceRoles(batch: EvidenceBatch): string[] {
  const roles = new Set<string>();
  for (const checkpoint of batch.checkpoints) for (const probe of checkpoint.probes) roles.add(probe.context);
  for (const watch of batch.watches) roles.add(watch.context);
  for (const series of batch.series) roles.add(series.probe.context);
  for (const action of batch.actions) {
    if (action.kind === 'keyboard' || action.kind === 'mouse') roles.add(action.target);
    if (action.kind === 'tool') roles.add(action.context);
    if (action.kind === 'wait_for' || action.kind === 'position' || action.kind === 'interaction') roles.add(action.context);
    if (action.kind === 'luau') roles.add(action.role);
  }
  return [...roles];
}

function lifecycleRunning(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.running === true || record.isRunning === true) return true;
  return ['running', 'playing', 'active'].includes(String(record.status ?? record.state ?? '').toLowerCase());
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).value === 'number') return (value as Record<string, unknown>).value as number;
  return undefined;
}

function actualValue(evidence: Record<string, unknown>): unknown {
  if ('value' in evidence) return evidence.value;
  if ('exists' in evidence) return evidence.exists;
  for (const key of ['occurrence_count', 'count', 'change_count', 'added_count']) if (key in evidence) return evidence[key];
  return evidence;
}

function occurrenceCount(evidence: Record<string, unknown>): number | undefined {
  for (const key of ['occurrence_count', 'change_count', 'added_count', 'count']) if (typeof evidence[key] === 'number') return evidence[key] as number;
  return undefined;
}

export function evaluateAssertion(assertion: EvidenceAssertion, evidence: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!evidence) return { id: assertion.id, evidence: assertion.evidence, condition: assertion.condition, status: 'missing_evidence', passed: false };
  const actual = actualValue(evidence);
  const initial = evidence.initial_value;
  const final = evidence.final_value;
  const count = occurrenceCount(evidence);
  const delta = numeric(final) !== undefined && numeric(initial) !== undefined ? numeric(final)! - numeric(initial)! : undefined;
  let passed = false;
  let supported = true;
  switch (assertion.condition) {
    case 'equals': passed = JSON.stringify(actual) === JSON.stringify(assertion.expected); break;
    case 'not_equals': passed = JSON.stringify(actual) !== JSON.stringify(assertion.expected); break;
    case 'exists': passed = evidence.exists === true; break;
    case 'absent': passed = evidence.exists === false; break;
    case 'unchanged': passed = initial !== undefined && final !== undefined && JSON.stringify(initial) === JSON.stringify(final); break;
    case 'changed': passed = initial !== undefined && final !== undefined && JSON.stringify(initial) !== JSON.stringify(final); break;
    case 'exact_count': passed = count !== undefined && count === assertion.expected; break;
    case 'minimum_count': passed = count !== undefined && typeof assertion.expected === 'number' && count >= assertion.expected; break;
    case 'maximum_count': passed = count !== undefined && typeof assertion.expected === 'number' && count <= assertion.expected; break;
    case 'zero_occurrences': passed = count === 0; break;
    case 'at_least_one_occurrence': passed = count !== undefined && count >= 1; break;
    case 'exact_numeric_delta': passed = delta !== undefined && typeof assertion.expected === 'number' && Math.abs(delta - assertion.expected) <= assertion.tolerance; break;
    case 'minimum_numeric_delta': passed = delta !== undefined && typeof assertion.expected === 'number' && delta >= assertion.expected - assertion.tolerance; break;
    case 'maximum_numeric_delta': passed = delta !== undefined && typeof assertion.expected === 'number' && delta <= assertion.expected + assertion.tolerance; break;
    default: supported = false;
  }
  return {
    id: assertion.id, evidence: assertion.evidence, condition: assertion.condition,
    expected: assertion.expected, actual: delta !== undefined && assertion.condition.includes('delta') ? delta : actual,
    status: supported ? 'evaluated' : 'unsupported', passed: supported && passed,
  };
}

export class ManagedRuntime {
  private revision = 0;
  private readonly sessions = new Map<string, EvidenceSession>();
  private readonly lifecycle = new Map<string, LifecycleRecord>();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(readonly chrrxs: ChrrxsAdapter, readonly telemetry: Telemetry, options: ManagedRuntimeOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  currentRevision(): string { return `r${this.revision}`; }

  notePersistentMutation(_kind: string): string {
    this.revision += 1;
    for (const session of this.sessions.values()) if (session.status === 'ready') session.status = 'stale';
    return this.currentRevision();
  }

  noteCallerLifecycleStart(instanceId: string | undefined, roles: string[]): void {
    this.lifecycle.set(instanceKey(instanceId), { revision: this.revision, owner: 'caller', roles });
  }

  noteLifecycleStop(instanceId: string | undefined): void {
    this.lifecycle.delete(instanceKey(instanceId));
    for (const session of this.sessions.values()) if (instanceKey(session.instance_id) === instanceKey(instanceId) && !['cleaned', 'failed'].includes(session.status)) session.status = 'failed';
  }

  session(id: string): EvidenceSession | undefined { return this.sessions.get(id); }

  async status(id: string): Promise<EvidenceReport> {
    const session = this.requireSession(id);
    if (session.status === 'ready') {
      await this.refreshHealth(session, session.required_roles);
      await this.refreshRuntimeState(session).catch(() => undefined);
    }
    const healthy = session.required_roles.every((role) => session.role_health[role]?.status === 'healthy' || session.role_health[role]?.status === 'recovered');
    const failed = session.status !== 'ready'
      ? failure({ category: 'infrastructure', code: 'TEST_SESSION_NOT_READY', stage: 'lifecycle status', summary: `The managed session status is ${session.status}, not ready.`, observed: { status: session.status }, retryable: 'no' })
      : healthy ? undefined : failure({ category: 'infrastructure', code: 'REQUIRED_HARNESS_ROLE_UNAVAILABLE', stage: 'harness installation/health', summary: 'At least one required harness role is unavailable.', observed: { role_health: session.role_health }, retryable: 'unknown' });
    return this.baseReport(session, ['session_status_checked'], healthy && session.status === 'ready', [], failed ? 'infrastructure' : undefined, failed?.code, failed);
  }

  async evaluateRuntimeCode(sessionId: string, role: 'server' | 'client-1', code: string, timeoutMs = 30_000): Promise<unknown> {
    const session = this.requireSession(sessionId);
    if (session.status !== 'ready') throw new Error(`TEST_SESSION_NOT_READY: ${session.status}`);
    if (!session.roles.includes(role)) throw new Error(`runtime role is unavailable: ${role}`);
    const tool = role === 'server' ? 'eval_server_runtime' : 'eval_client_runtime';
    const raw = await this.chrrxs.callJson(tool, {
      code, ...(role.startsWith('client-') ? { target: role } : {}), ...(session.instance_id ? { instance_id: session.instance_id } : {}),
    }, timeoutMs);
    return parseExecuteResult(raw);
  }

  async executeRuntimeLuau(sessionId: string, role: 'server' | 'client-1', source: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(source, 'utf8') > CALLER_LUAU_SOURCE_MAX_BYTES) {
      return { success: false, error_code: 'LUAU_SOURCE_TOO_LARGE', limit_bytes: CALLER_LUAU_SOURCE_MAX_BYTES };
    }
    const value = await this.evaluateRuntimeCode(sessionId, role, compileCallerLuau(source), timeoutMs);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? normalizeResult(value) as Record<string, unknown>
      : { success: false, error_code: 'LUAU_RESULT_MALFORMED' };
  }

  async begin(options: { instance_id?: string; play_mode: 'play' | 'run'; refresh_incompatible?: boolean; required_roles?: Array<'server' | 'client-1'> }): Promise<EvidenceReport> {
    const id = randomUUID();
    const requiredRoles: Array<'server' | 'client-1'> = options.required_roles ?? (options.play_mode === 'play' ? ['server', 'client-1'] : ['server']);
    const key = instanceKey(options.instance_id);
    const transitions: string[] = ['status_checked'];
    let status: unknown;
    try {
      status = await this.chrrxs.callJson('solo_playtest', { action: 'status', ...(options.instance_id ? { instance_id: options.instance_id } : {}) }, 30_000);
    } catch (error) {
      return this.failedBegin(id, options, transitions, 'TEST_ACQUISITION_FAILED', `Playtest status could not be read: ${compactError(error)}`);
    }
    const running = lifecycleRunning(status);
    let record = this.lifecycle.get(key);
    let ownership: LifecycleOwnership;
    let roles = targetsIn(status);
    if (running) {
      if (!record || record.revision !== this.revision) {
        if (record?.owner === 'runtime' && options.refresh_incompatible) {
          await this.stopOwnedLifecycle(key, record, options.instance_id, transitions);
          record = undefined;
        } else {
          return this.failedBegin(id, options, transitions, 'TEST_RUNTIME_INCOMPATIBLE', 'an active caller-owned or stale playtest cannot be safely reused');
        }
      }
      if (record && record.revision === this.revision) {
        const existing = record.owner_session_id ? this.sessions.get(record.owner_session_id) : [...this.sessions.values()].find((item) => instanceKey(item.instance_id) === key && item.ownership === 'caller-owned' && item.status === 'ready' && item.revision === this.revision);
        if (existing?.status === 'ready' && requiredRoles.every((role) => existing.roles.includes(role))) {
          const healthy = await this.refreshHealth(existing, requiredRoles);
          if (healthy) {
            existing.required_roles = [...new Set([...existing.required_roles, ...requiredRoles])];
            await this.refreshRuntimeState(existing);
            return this.baseReport(existing, [...transitions, 'existing_session_reused'], true, []);
          }
          await this.finish(existing.id);
          record = this.lifecycle.get(key);
        }
      }
    }
    if (!running || !record) {
      let started: unknown;
      try {
        started = await this.chrrxs.callJson('solo_playtest', {
          action: 'start', mode: options.play_mode, ...(options.instance_id ? { instance_id: options.instance_id } : {}),
        }, 180_000);
      } catch (error) {
        return this.failedBegin(id, options, transitions, 'TEST_ACQUISITION_START_AMBIGUOUS', `Playtest start did not produce a trustworthy result: ${compactError(error)}`);
      }
      transitions.push('playtest_started');
      roles = targetsIn(started);
      if (!roles.length) roles = options.play_mode === 'play' ? ['server', 'client-1'] : ['server'];
      record = { revision: this.revision, owner: 'runtime', owner_session_id: id, roles };
      this.lifecycle.set(key, record);
      ownership = 'runtime-owned';
    } else {
      roles = record.roles.length ? record.roles : roles;
      ownership = 'caller-owned';
      transitions.push('compatible_playtest_reused');
    }
    roles = requiredRoles.filter((role) => roles.includes(role));
    const session: EvidenceSession = {
      id, instance_id: options.instance_id, revision: this.revision, status: 'ready', ownership, roles,
      required_roles: requiredRoles, role_health: {},
      play_mode: options.play_mode, started_at: this.now(), refresh_count: 0, held_keys: new Map(), held_buttons: new Map(),
      reports: [], managed_artifacts: [], sample_count: 0,
    };
    this.sessions.set(id, session);
    this.chrrxs.startRuntimeLogSession(options.instance_id, roles);
    const warnings: string[] = [];
    const availableRoles: string[] = [];
    for (const role of requiredRoles) {
      try {
        await this.evaluate(role, options.instance_id, { operation: 'begin', session_id: id, role, revision: this.currentRevision() });
        session.managed_artifacts.push(`runtime:${role}:RobloxAgentManagedEvidence`);
        availableRoles.push(role);
        session.role_health[role] = { status: 'healthy' };
      } catch (error) {
        warnings.push(`${role} harness unavailable: ${compactError(error)}`);
        session.role_health[role] = { status: 'unavailable', observed: compactError(error) };
      }
    }
    session.roles = availableRoles;
    const activeRecord = this.lifecycle.get(key);
    if (activeRecord) activeRecord.roles = availableRoles;
    const missingRoles = requiredRoles.filter((role) => !availableRoles.includes(role));
    if (missingRoles.length) {
      const cleaned = await this.finish(id);
      const failed = this.baseReport(session, [...transitions, ...cleaned.lifecycle.transitions], false, warnings, 'infrastructure', 'REQUIRED_HARNESS_ROLE_UNAVAILABLE', failure({ category: 'infrastructure', code: 'REQUIRED_HARNESS_ROLE_UNAVAILABLE', stage: 'harness installation/health', summary: `Required runtime role(s) did not become healthy: ${missingRoles.join(', ')}.`, observed: { role_health: session.role_health }, retryable: 'unknown' }));
      failed.cleanup = cleaned.cleanup;
      failed.runtime_errors = cleaned.runtime_errors;
      failed.logs = cleaned.logs;
      failed.recommended_next_action = 'Inspect the unavailable role health and final incremental logs before retrying once.';
      session.final_report = failed;
      return failed;
    }
    try {
      await this.refreshRuntimeState(session);
    } catch (error) {
      const cleaned = await this.finish(id);
      const message = compactError(error);
      const structured = failure({ category: 'infrastructure', code: 'RUNTIME_STATE_ACQUISITION_FAILED', stage: 'runtime state snapshot', summary: message, observed: { role_health: session.role_health }, retryable: 'unknown' });
      const failed = this.baseReport(session, [...transitions, ...cleaned.lifecycle.transitions], false, [message], 'infrastructure', structured.code, structured);
      failed.cleanup = cleaned.cleanup;
      failed.runtime_errors = cleaned.runtime_errors;
      failed.logs = cleaned.logs;
      failed.recommended_next_action = 'Inspect role health and incremental runtime logs before retrying once.';
      session.final_report = failed;
      return failed;
    }
    return this.baseReport(session, transitions, true, warnings);
  }

  async runBatch(sessionId: string, batch: EvidenceBatch, refreshStale = false): Promise<BatchResult> {
    const session = this.requireSession(sessionId);
    const transitions: string[] = [];
    if (session.status === 'stale') {
      if (!refreshStale || session.ownership !== 'runtime-owned' || session.refresh_count >= 1) {
        const stale = failure({ category: 'stale', code: 'TEST_SESSION_STALE', stage: 'revision compatibility', summary: `Session revision r${session.revision} does not match current revision ${this.currentRevision()}.`, expected: this.currentRevision(), observed: `r${session.revision}`, retryable: session.ownership === 'runtime-owned' && session.refresh_count < 1 ? 'yes' : 'no' });
        return { report: this.baseReport(session, transitions, false, [], 'stale', stale.code, stale), images: [] };
      }
      await this.refresh(session, transitions);
    }
    if (session.status !== 'ready') {
      const unavailable = failure({ category: 'infrastructure', code: 'TEST_SESSION_NOT_READY', stage: 'lifecycle status', summary: `The managed session status is ${session.status}, not ready.`, observed: { status: session.status }, retryable: 'no' });
      return { report: this.baseReport(session, transitions, false, [], 'infrastructure', unavailable.code, unavailable), images: [] };
    }
    if (!(await this.refreshHealth(session, session.required_roles))) {
      const failed = failure({ category: 'infrastructure', code: 'REQUIRED_HARNESS_ROLE_UNAVAILABLE', stage: 'harness installation/health', summary: 'A required evidence harness role did not pass its bounded health check.', observed: { role_health: session.role_health }, retryable: 'unknown' });
      const cleaned = await this.finish(session.id);
      const report = this.baseReport(session, [...transitions, ...cleaned.lifecycle.transitions], false, [], 'infrastructure', failed.code, failed);
      report.cleanup = cleaned.cleanup;
      return { report, images: [] };
    }
    const unavailableRoles = evidenceRoles(batch).filter((role) => !session.roles.includes(role));
    if (unavailableRoles.length) {
      const unavailable = failure({ category: 'infrastructure', code: 'RUNTIME_ROLE_UNAVAILABLE', stage: 'role discovery', summary: `Requested runtime role(s) are unavailable: ${unavailableRoles.join(', ')}.`, expected: evidenceRoles(batch), observed: session.roles, retryable: 'unknown' });
      return { report: this.baseReport(session, transitions, false, [], 'infrastructure', unavailable.code, unavailable), images: [] };
    }
    const requestedSamples = batch.series.reduce((total, item) => total + Math.floor(item.duration_ms / item.interval_ms) + 1, 0);
    if (session.sample_count + requestedSamples > 500) {
      return { report: this.baseReport(session, transitions, false, ['cumulative session sample limit is 500'], 'infrastructure', 'EVIDENCE_SAMPLE_LIMIT'), images: [] };
    }

    const actions: Array<Record<string, unknown>> = [];
    const observations: Array<Record<string, unknown>> = [];
    const watches: Array<Record<string, unknown>> = [];
    const series: Array<Record<string, unknown>> = [];
    const assertions: Array<Record<string, unknown>> = [];
    const images: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const evidence = new Map<string, Record<string, unknown>>();
    const collectedRoles = new Set<string>();
    const installedRoles = new Set<string>();
    let infrastructureFailure = false;
    let actionFailure = false;
    let seriesStarted = this.now();
    const batchStarted = this.now();

    try {
      for (const role of session.roles) {
        const roleWatches = batch.watches.filter((item) => item.context === role);
        const roleSeries = batch.series.filter((item) => item.probe.context === role).map((item) => ({
          ...item, probe: { ...item.probe, id: item.id },
        }));
        if (roleWatches.length || roleSeries.length) {
          await this.evaluate(role, session.instance_id, { operation: 'install', session_id: session.id, role, watches: roleWatches, series: roleSeries });
          installedRoles.add(role);
        }
      }
      seriesStarted = this.now();
      await this.evaluateCheckpoints(session, batch, 'before', observations, evidence);
      for (let index = 0; index < batch.actions.length; index += 1) {
        const action = batch.actions[index]!;
        if (this.now() - batchStarted >= batch.deadline_ms) {
          const timedOut = failure({ category: 'readiness', code: 'BATCH_DEADLINE_EXCEEDED', stage: 'action prerequisite', summary: `The batch reached its ${batch.deadline_ms} ms deadline before action ${index}.`, deadline_ms: batch.deadline_ms, elapsed_ms: this.now() - batchStarted, retryable: 'unknown' });
          actions.push({ id: action.id ?? `action-${index}`, kind: action.kind, success: false, failure: timedOut, error_code: timedOut.code }); actionFailure = true; break;
        }
        const remaining = Math.max(1, batch.deadline_ms - (this.now() - batchStarted));
        const result = await this.performAction(session, action, index, images, remaining);
        actions.push(result);
        if (action.id) evidence.set(action.id, result);
        if (result.success !== true) {
          actionFailure = true;
          if (result.infrastructure === true) infrastructureFailure = true;
          if (!batch.continue_on_failure) break;
        }
      }
      const maxSeriesDuration = batch.series.reduce((maximum, item) => Math.max(maximum, item.duration_ms), 0);
      const elapsed = this.now() - seriesStarted;
      const remainingForSeries = Math.max(0, batch.deadline_ms - (this.now() - batchStarted));
      if (maxSeriesDuration > 0 && maxSeriesDuration + 25 > elapsed && remainingForSeries > 0) await this.sleep(Math.min(maxSeriesDuration + 25 - elapsed, remainingForSeries));
      await this.evaluateCheckpoints(session, batch, 'after', observations, evidence);
      for (const role of session.roles) {
        if (!installedRoles.has(role)) continue;
        const collected = await this.evaluate(role, session.instance_id, { operation: 'collect', session_id: session.id, role }) as Record<string, unknown>;
        collectedRoles.add(role);
        for (const item of Array.isArray(collected.watches) ? collected.watches as Array<Record<string, unknown>> : []) { watches.push(item); if (typeof item.id === 'string') evidence.set(item.id, item); }
        for (const item of Array.isArray(collected.series) ? collected.series as Array<Record<string, unknown>> : []) { series.push(item); if (typeof item.id === 'string') evidence.set(item.id, item); }
      }
    } catch (error) {
      infrastructureFailure = true;
      warnings.push(compactError(error));
    } finally {
      for (const role of session.roles) {
        if (!installedRoles.has(role) || collectedRoles.has(role)) continue;
        try { await this.evaluate(role, session.instance_id, { operation: 'reset', session_id: session.id, role }); }
        catch (error) { infrastructureFailure = true; warnings.push(`${role} batch cleanup: ${compactError(error)}`); }
      }
    }
    for (const assertion of batch.assertions) assertions.push(evaluateAssertion(assertion, evidence.get(assertion.evidence)));
    const behavioralFailure = actionFailure || assertions.some((item) => item.passed !== true);
    const report: EvidenceReport = {
      ...this.baseReport(session, transitions, !infrastructureFailure && !behavioralFailure, warnings,
        infrastructureFailure ? 'infrastructure' : behavioralFailure ? 'behavioral' : undefined),
      actions, observations, watches, series, assertions,
    };
    const firstActionFailure = actions.find((item) => item.success !== true)?.failure as StructuredFailure | undefined;
    const firstAssertionFailure = assertions.find((item) => item.passed !== true);
    if (firstActionFailure) { report.failure = firstActionFailure; report.error_code = firstActionFailure.code; report.failure_kind = failureKind(firstActionFailure.category); }
    else if (firstAssertionFailure) { report.failure = failure({ category: 'assertion', code: 'ASSERTION_FAILED', stage: 'assertion evaluation', summary: `Assertion ${String(firstAssertionFailure.id)} did not pass.`, expected: firstAssertionFailure.expected, observed: firstAssertionFailure.actual, retryable: 'unknown' }); report.error_code = report.failure.code; }
    else if (infrastructureFailure) { report.failure = failure({ category: 'infrastructure', code: 'EVIDENCE_INFRASTRUCTURE_FAILURE', stage: 'evidence collection', summary: warnings[0] ?? 'The evidence harness operation failed.', observed: { warnings: warnings.slice(0, 10) }, retryable: 'unknown' }); report.error_code = report.failure.code; }
    await this.refreshRuntimeState(session).catch(() => undefined);
    report.runtime_state = session.runtime_state;
    if (JSON.stringify(report).length > 128_000) {
      report.warnings.push('REPORT_TRUNCATED_128KB');
      for (const item of report.series) if (Array.isArray(item.samples) && item.samples.length > 20) { item.samples = item.samples.slice(0, 20); item.truncated = true; }
      for (const item of report.watches) if (Array.isArray(item.events) && item.events.length > 20) { item.events = item.events.slice(0, 20); item.truncated = true; }
      if (JSON.stringify(report).length > 128_000) {
        for (const item of report.series) if (Array.isArray(item.samples) && item.samples.length > 5) { item.samples = item.samples.slice(0, 5); item.truncated = true; }
        for (const item of report.watches) if (Array.isArray(item.events) && item.events.length > 5) { item.events = item.events.slice(0, 5); item.truncated = true; }
      }
      if (JSON.stringify(report).length > 128_000) {
        for (const item of report.series) if (Array.isArray(item.samples)) { item.samples = []; item.truncated = true; }
        for (const item of report.watches) if (Array.isArray(item.events)) { item.events = []; item.truncated = true; }
      }
    }
    session.reports.push(report);
    session.sample_count += series.reduce((total, item) => total + (typeof item.sample_count === 'number' ? item.sample_count : 0), 0);
    if (session.reports.length > 20) session.reports.shift();
    return { report, images };
  }

  async finish(sessionId: string): Promise<EvidenceReport> {
    const session = this.requireSession(sessionId);
    if (session.final_report) return session.final_report;
    session.status = 'ending';
    const transitions: string[] = [];
    const warnings: string[] = [];
    let logs: RuntimeLogCollection | undefined;
    try {
      logs = await this.chrrxs.collectRuntimeLogs({ instance_id: session.instance_id, tail: 100, timeout_ms: 1_000 });
      transitions.push('final_logs_collected');
    } catch (error) { warnings.push(`final logs: ${compactError(error)}`); }
    const released = await this.releaseInputs(session, warnings);
    const cleanup = await this.cleanupHarnesses(session, warnings);
    let stopped = false;
    const record = this.lifecycle.get(instanceKey(session.instance_id));
    if (session.ownership === 'runtime-owned' && record?.owner_session_id === session.id) {
      try {
        await this.chrrxs.callJson('solo_playtest', { action: 'stop', ...(session.instance_id ? { instance_id: session.instance_id } : {}) }, 180_000);
        stopped = true; transitions.push('owned_playtest_stopped'); this.lifecycle.delete(instanceKey(session.instance_id));
      } catch (error) { warnings.push(`owned stop: ${compactError(error)}`); }
    }
    this.chrrxs.endRuntimeLogSession(session.instance_id);
    session.status = warnings.length ? 'failed' : 'cleaned';
    const runtimeErrors = this.findRuntimeErrors(logs?.entries);
    const cleanupFailure = warnings.length ? failure({ category: 'cleanup', code: 'MANAGED_CLEANUP_PARTIAL', stage: warnings.some((item) => item.startsWith('owned stop')) ? 'playtest stop' : warnings.some((item) => item.includes('release')) ? 'input release' : 'harness cleanup', summary: `Managed cleanup was partial: ${warnings[0]}`, observed: { warnings: warnings.slice(0, 10), released, cleanup, owned_playtest_stopped: stopped }, retryable: 'unknown' }) : undefined;
    const report: EvidenceReport = {
      ...this.baseReport(session, transitions, warnings.length === 0, warnings, warnings.length ? 'infrastructure' : undefined, cleanupFailure?.code, cleanupFailure),
      actions: [], observations: [], watches: [], series: [], assertions: [], runtime_errors: runtimeErrors,
      ...(logs ? { logs: normalizeResult(logs, { maxArray: 100, maxString: 2_000 }) } : {}),
      cleanup: { input_releases: released, harnesses: cleanup, owned_playtest_stopped: stopped, caller_playtest_preserved: session.ownership === 'caller-owned' },
      summary: {
        batches: session.reports.length,
        successful_batches: session.reports.filter((item) => item.success).length,
        actions: session.reports.reduce((total, item) => total + item.actions.length, 0),
        probes: session.reports.reduce((total, item) => total + item.observations.reduce((count, checkpoint) => count + (Array.isArray(checkpoint.probes) ? checkpoint.probes.length : 0), 0), 0),
        watches: session.reports.reduce((total, item) => total + item.watches.length, 0),
        samples: session.sample_count,
        assertions: session.reports.reduce((total, item) => total + item.assertions.length, 0),
        assertion_failures: session.reports.reduce((total, item) => total + item.assertions.filter((assertion) => assertion.passed !== true).length, 0),
      },
    };
    session.final_report = report;
    return report;
  }

  async scenario(options: { instance_id?: string; play_mode: 'play' | 'run'; batch: EvidenceBatch; required_roles?: Array<'server' | 'client-1'> }): Promise<BatchResult> {
    const begin = await this.begin({ instance_id: options.instance_id, play_mode: options.play_mode, required_roles: options.required_roles });
    if (!begin.success) return { report: begin, images: [] };
    const id = begin.session.id;
    let batchResult!: BatchResult;
    let final!: EvidenceReport;
    try { batchResult = await this.runBatch(id, options.batch); }
    finally { final = await this.finish(id); }
    batchResult.report.cleanup = final.cleanup;
    batchResult.report.runtime_errors = final.runtime_errors;
    batchResult.report.logs = final.logs;
    batchResult.report.lifecycle.transitions.push(...final.lifecycle.transitions);
    batchResult.report.success = batchResult.report.success && final.success;
    if (!final.success && !batchResult.report.failure_kind) batchResult.report.failure_kind = 'infrastructure';
    if (!final.success && !batchResult.report.failure) { batchResult.report.failure = final.failure; batchResult.report.error_code = final.error_code; }
    return batchResult;
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) if (!['cleaned', 'failed'].includes(session.status)) await this.finish(session.id).catch(() => undefined);
  }

  private async evaluateCheckpoints(session: EvidenceSession, batch: EvidenceBatch, phase: 'before' | 'after', output: Array<Record<string, unknown>>, evidence: Map<string, Record<string, unknown>>): Promise<void> {
    for (const checkpoint of batch.checkpoints.filter((item) => item.phase === phase)) {
      const results: Array<Record<string, unknown>> = [];
      for (const role of session.roles) {
        const probes = checkpoint.probes.filter((probe) => probe.context === role);
        if (!probes.length) continue;
        const response = await this.evaluate(role, session.instance_id, { operation: 'probe', session_id: session.id, role, probes }) as Record<string, unknown>;
        for (const item of Array.isArray(response.probes) ? response.probes as Array<Record<string, unknown>> : []) { results.push(item); if (typeof item.id === 'string') evidence.set(item.id, item); }
      }
      output.push({ id: checkpoint.id, phase, probes: results });
    }
  }

  private async performAction(session: EvidenceSession, action: EvidenceAction, index: number, images: Array<Record<string, unknown>>, remainingMs: number): Promise<Record<string, unknown>> {
    const started = this.relative(session);
    try {
      let details: unknown;
      if (action.kind === 'wait') {
        const waited = Math.min(action.duration_ms, remainingMs); await this.sleep(waited); details = { requested_ms: action.duration_ms, waited_ms: waited };
        if (waited < action.duration_ms) return this.failedAction(session, action, index, started, { error_code: 'BATCH_DEADLINE_EXCEEDED', elapsed_ms: waited, observed: { requested_ms: action.duration_ms, waited_ms: waited } }, 'readiness', 'batch deadline');
      }
      else if (action.kind === 'keyboard') {
        details = await this.chrrxs.callJson('simulate_keyboard_input', {
          keyCode: action.key_code, action: action.action, duration: action.duration_ms / 1000, target: action.target,
          ...(session.instance_id ? { instance_id: session.instance_id } : {}),
        }, Math.min(10_000, remainingMs));
        const key = `${action.target}\u0000${action.key_code}`;
        if (action.action === 'press') session.held_keys.set(key, { target: action.target, key_code: action.key_code });
        if (action.action === 'release') session.held_keys.delete(key);
      } else if (action.kind === 'mouse') {
        const mapped = action.action === 'down' ? 'mouseDown' : action.action === 'up' ? 'mouseUp' : 'click';
        details = await this.chrrxs.callJson('simulate_mouse_input', {
          action: mapped, x: action.x, y: action.y, button: action.button, target: action.target,
          ...(session.instance_id ? { instance_id: session.instance_id } : {}),
        }, Math.min(10_000, remainingMs));
        const key = `${action.target}\u0000${action.button}`;
        if (action.action === 'down') session.held_buttons.set(key, { target: action.target, x: action.x, y: action.y, button: action.button });
        if (action.action === 'up') session.held_buttons.delete(key);
      } else if (action.kind === 'tool') {
        details = await this.evaluate(action.context, session.instance_id, {
          operation: 'tool', session_id: session.id, role: action.context, tool_operation: action.operation,
          target: action.target, player: action.player, auto_equip: action.auto_equip,
          timeout_ms: Math.min(action.timeout_ms, remainingMs), poll_interval_ms: action.poll_interval_ms,
        });
        if ((details as Record<string, unknown>).success !== true) return this.failedAction(session, action, index, started, details, 'readiness', action.operation === 'activate' ? 'post-action verification' : 'Tool prerequisite');
      } else if (action.kind === 'wait_for') {
        details = await this.evaluate(action.context, session.instance_id, {
          operation: 'wait_for', session_id: session.id, role: action.context, condition: action.condition,
          path: action.path, player: action.player, tool: action.tool, interaction: action.interaction,
          timeout_ms: Math.min(action.timeout_ms, remainingMs), poll_interval_ms: action.poll_interval_ms,
        });
        if ((details as Record<string, unknown>).success !== true) return this.failedAction(session, action, index, started, details, 'readiness', `${action.condition} readiness`);
      } else if (action.kind === 'position') {
        details = await this.evaluate(action.context, session.instance_id, {
          operation: 'position', session_id: session.id, role: action.context, subject: action.subject, destination: action.destination,
          offset: action.offset, offset_space: action.offset_space, orientation: action.orientation, timeout_ms: Math.min(action.timeout_ms, remainingMs), tolerance: action.tolerance,
        });
        if ((details as Record<string, unknown>).success !== true) return this.failedAction(session, action, index, started, details, 'setup', 'post-action verification');
      } else if (action.kind === 'interaction') {
        details = await this.evaluate('client-1', session.instance_id, {
          operation: 'interaction', session_id: session.id, role: 'client-1', interaction: action.interaction,
          path: action.path, button: action.button, timeout_ms: Math.min(action.timeout_ms, remainingMs), poll_interval_ms: action.poll_interval_ms,
        });
        const detail = details as Record<string, unknown>;
        if (detail.success !== true) return this.failedAction(session, action, index, started, details, 'interaction', detail.error_code === 'CLICK_TARGET_OFFSCREEN' ? 'screen projection' : 'interaction prerequisite');
        if (detail.dispatch === 'mouse') {
          await this.chrrxs.callJson('simulate_mouse_input', {
            action: 'click', x: detail.x, y: detail.y, button: detail.button, target: 'client-1',
            ...(session.instance_id ? { instance_id: session.instance_id } : {}),
          }, Math.min(10_000, remainingMs));
          details = { ...detail, input_dispatched: true };
        }
      } else if (action.kind === 'luau') {
        const result = await this.executeRuntimeLuau(session.id, action.role, action.source, Math.min(action.timeout_ms, remainingMs));
        if (result.success !== true) {
          const code = typeof result.error_code === 'string' ? result.error_code : 'CALLER_LUAU_FAILED';
          const structured = failure({
            category: 'interaction', code, stage: `${action.role} runtime Luau`,
            summary: `Targeted ${action.role} Luau did not complete successfully.`, observed: result, retryable: 'no',
          });
          return { id: action.id, kind: action.kind, context: action.role, role: action.role, start_time: started, end_time: this.relative(session), success: false, result, error_code: code, failure: structured, retry_performed: false };
        }
        const value = result.value;
        details = { role: action.role, result: value };
        const actionResult: Record<string, unknown> = {
          id: action.id, kind: action.kind, context: action.role, role: action.role, start_time: started,
          end_time: this.relative(session), success: true, details, retry_performed: false,
        };
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) actionResult.value = value;
        return actionResult;
      } else {
        const screenshot = await this.chrrxs.call('capture_screenshot', {
          format: action.format, quality: action.quality, ...(session.instance_id ? { instance_id: session.instance_id } : {}),
        }, Math.min(120_000, remainingMs));
        const blocks = screenshot.content.filter((block) => block.type === 'image') as Array<Record<string, unknown>>;
        if (!blocks.length) throw new Error('screenshot returned no image');
        const indexes = blocks.map((block) => { images.push(block); return images.length; });
        details = { image_indexes: indexes };
      }
      const actionContext = action.kind === 'keyboard' || action.kind === 'mouse' ? action.target
        : action.kind === 'tool' || action.kind === 'wait_for' || action.kind === 'position' || action.kind === 'interaction' ? action.context
          : 'manager';
      return { id: action.id ?? `action-${index}`, kind: action.kind, context: actionContext, start_time: started, end_time: this.relative(session), success: true, details };
    } catch (error) {
      const summary = compactError(error);
      const structured = failure({ category: 'infrastructure', code: action.kind === 'luau' ? 'RUNTIME_LUAU_TRANSPORT_FAILED' : 'ACTION_TRANSPORT_FAILED', stage: action.kind === 'luau' ? `${action.role} runtime Luau` : 'input dispatch', summary, observed: { kind: action.kind, ...(action.kind === 'luau' ? { role: action.role } : {}) }, retryable: action.kind === 'luau' ? 'no' : 'unknown' });
      return { id: action.id ?? `action-${index}`, kind: action.kind, start_time: started, end_time: this.relative(session), success: false, error: summary, infrastructure: true, error_code: structured.code, failure: structured };
    }
  }

  private failedAction(session: EvidenceSession, action: EvidenceAction, index: number, started: number, details: unknown, category: 'readiness' | 'setup' | 'interaction', stage: string): Record<string, unknown> {
    const record = details && typeof details === 'object' ? details as Record<string, unknown> : {};
    const code = typeof record.error_code === 'string' ? record.error_code : 'ACTION_FAILED';
    const retryable = code === 'WRONG_CLASS' ? 'no' as const : 'unknown' as const;
    const summary = this.actionSummary(action, code, record);
    const structured = failure({ category, code, stage, summary, last_successful_checkpoint: typeof record.last_successful_checkpoint === 'string' ? record.last_successful_checkpoint : 'harness healthy', observed: record.observed ?? record, deadline_ms: 'timeout_ms' in action ? action.timeout_ms : undefined, elapsed_ms: typeof record.elapsed_ms === 'number' ? record.elapsed_ms : this.relative(session) - started, retryable, diagnostics: { runtime_state: session.runtime_state } });
    return { id: action.id ?? `action-${index}`, kind: action.kind, context: 'context' in action ? action.context : undefined, start_time: started, end_time: this.relative(session), success: false, details, error_code: code, failure: structured };
  }

  private actionSummary(action: EvidenceAction, code: string, observed: Record<string, unknown>): string {
    if (code === 'TOOL_READINESS_TIMEOUT') return `The requested Tool prerequisites did not all become available before the ${'timeout_ms' in action ? action.timeout_ms : 'bounded'} ms deadline.`;
    if (code === 'READINESS_TIMEOUT') return `${'condition' in action ? action.condition : 'Requested'} readiness was not observed before the bounded deadline.`;
    if (code === 'CLICK_TARGET_OFFSCREEN') return 'The ClickDetector resolved, but its parent projected outside the current client viewport.';
    if (code === 'GUI_ZERO_SIZE') return 'The GuiButton existed and was visible, but its absolute bounds had zero area.';
    if (code === 'GUI_NOT_INTERACTABLE') return 'The GuiButton resolved, but its effective ancestor state was not interactable.';
    if (code === 'PROMPT_OUT_OF_RANGE') return `The ProximityPrompt resolved, but the observed distance ${String(observed.distance)} exceeded MaxActivationDistance ${String(observed.max_activation_distance)}.`;
    if (code === 'WRONG_CLASS') return `The exact target resolved as ${String(observed.actual_class ?? 'an unexpected class')}, which is not valid for this action.`;
    return `The ${action.kind} action failed with ${code}; the report contains only the state observed at that protocol stage.`;
  }

  private async refresh(session: EvidenceSession, transitions: string[]): Promise<void> {
    const warnings: string[] = [];
    await this.releaseInputs(session, warnings);
    await this.cleanupHarnesses(session, warnings);
    await this.chrrxs.collectRuntimeLogs({ instance_id: session.instance_id, tail: 100, timeout_ms: 1_000 }).catch(() => undefined);
    await this.chrrxs.callJson('solo_playtest', { action: 'stop', ...(session.instance_id ? { instance_id: session.instance_id } : {}) }, 180_000);
    transitions.push('stale_owned_playtest_stopped');
    const started = await this.chrrxs.callJson('solo_playtest', { action: 'start', mode: session.play_mode, ...(session.instance_id ? { instance_id: session.instance_id } : {}) }, 180_000);
    session.roles = targetsIn(started); if (!session.roles.length) session.roles = session.play_mode === 'play' ? ['server', 'client-1'] : ['server'];
    session.revision = this.revision; session.refresh_count += 1; session.status = 'ready';
    this.lifecycle.set(instanceKey(session.instance_id), { revision: this.revision, owner: 'runtime', owner_session_id: session.id, roles: session.roles });
    for (const role of session.roles) await this.evaluate(role, session.instance_id, { operation: 'begin', session_id: session.id, role, revision: this.currentRevision() });
    transitions.push('session_refreshed');
  }

  private async releaseInputs(session: EvidenceSession, warnings: string[]): Promise<number> {
    let released = 0;
    for (const item of session.held_keys.values()) try {
      await this.chrrxs.callJson('simulate_keyboard_input', { keyCode: item.key_code, action: 'release', target: item.target, ...(session.instance_id ? { instance_id: session.instance_id } : {}) }, 10_000); released += 1;
    } catch (error) { warnings.push(`key release: ${compactError(error)}`); }
    for (const item of session.held_buttons.values()) try {
      await this.chrrxs.callJson('simulate_mouse_input', { action: 'mouseUp', x: item.x, y: item.y, button: item.button, target: item.target, ...(session.instance_id ? { instance_id: session.instance_id } : {}) }, 10_000); released += 1;
    } catch (error) { warnings.push(`mouse release: ${compactError(error)}`); }
    session.held_keys.clear(); session.held_buttons.clear(); return released;
  }

  private async cleanupHarnesses(session: EvidenceSession, warnings: string[]): Promise<Record<string, unknown>> {
    const cleaned: string[] = [], failed: string[] = [];
    for (const role of session.roles) try {
      await this.evaluate(role, session.instance_id, { operation: 'cleanup', session_id: session.id, role }); cleaned.push(role);
    } catch (error) { failed.push(role); warnings.push(`${role} cleanup: ${compactError(error)}`); }
    session.managed_artifacts = session.managed_artifacts.filter((item) => !cleaned.some((role) => item.startsWith(`runtime:${role}:`)));
    return { cleaned, failed, remaining: session.managed_artifacts };
  }

  private async evaluate(role: string, instanceId: string | undefined, request: Record<string, unknown>): Promise<unknown> {
    const tool = role === 'server' ? 'eval_server_runtime' : 'eval_client_runtime';
    const raw = await this.chrrxs.callJson(tool, {
      code: compileEvidenceHarness(request as Record<string, unknown> & { operation: never }),
      ...(role.startsWith('client-') ? { target: role } : {}), ...(instanceId ? { instance_id: instanceId } : {}),
    }, 30_000);
    return parseExecuteResult(raw);
  }

  private async refreshHealth(session: EvidenceSession, roles: string[]): Promise<boolean> {
    let allHealthy = true;
    for (const role of roles) {
      try {
        await this.evaluate(role, session.instance_id, { operation: 'health', session_id: session.id, role });
        session.role_health[role] = { status: 'healthy' };
      } catch (firstError) {
        try {
          await this.evaluate(role, session.instance_id, { operation: 'begin', session_id: session.id, role, revision: this.currentRevision() });
          await this.evaluate(role, session.instance_id, { operation: 'health', session_id: session.id, role });
          if (!session.managed_artifacts.includes(`runtime:${role}:RobloxAgentManagedEvidence`)) session.managed_artifacts.push(`runtime:${role}:RobloxAgentManagedEvidence`);
          if (!session.roles.includes(role)) session.roles.push(role);
          session.role_health[role] = { status: 'recovered', recovery_attempts: 1 };
        } catch (secondError) {
          allHealthy = false;
          session.role_health[role] = { status: 'unavailable', recovery_attempts: 1, first_observed: compactError(firstError), observed: compactError(secondError) };
        }
      }
    }
    return allHealthy;
  }

  private async refreshRuntimeState(session: EvidenceSession): Promise<void> {
    const role = session.roles.includes('client-1') ? 'client-1' : session.roles.includes('server') ? 'server' : undefined;
    if (!role) { session.runtime_state = { playtest_running: true, available_roles: [], harness_health: session.role_health, player_available: false }; return; }
    const response = await this.evaluate(role, session.instance_id, { operation: 'snapshot', session_id: session.id, role }) as Record<string, unknown>;
    session.runtime_state = { playtest_running: true, available_roles: session.roles, harness_health: session.role_health, snapshot_role: role, ...(response.state && typeof response.state === 'object' ? response.state as Record<string, unknown> : {}) };
  }

  private baseReport(session: EvidenceSession, transitions: string[], success: boolean, warnings: string[], failureKind?: EvidenceReport['failure_kind'], errorCode?: string, structured?: StructuredFailure): EvidenceReport {
    return {
      success,
      session: { id: session.id, status: session.status, ...(session.instance_id ? { instance_id: session.instance_id } : {}), revision: `r${session.revision}`, current_revision: this.currentRevision(), ownership: session.ownership, roles: session.roles, required_roles: session.required_roles, refresh_count: session.refresh_count },
      lifecycle: { transitions }, actions: [], observations: [], watches: [], series: [], assertions: [], runtime_errors: [], cleanup: {}, warnings,
      role_health: session.role_health, ...(session.runtime_state ? { runtime_state: session.runtime_state } : {}),
      ...(failureKind ? { failure_kind: failureKind } : {}), ...(errorCode ? { error_code: errorCode } : {}), ...(structured ? { failure: structured } : {}),
    };
  }

  private failedBegin(id: string, options: { instance_id?: string; play_mode: 'play' | 'run'; required_roles?: Array<'server' | 'client-1'> }, transitions: string[], code: string, message: string): EvidenceReport {
    const session: EvidenceSession = { id, instance_id: options.instance_id, revision: this.revision, status: 'failed', ownership: 'caller-owned', roles: [], required_roles: options.required_roles ?? (options.play_mode === 'play' ? ['server', 'client-1'] : ['server']), role_health: {}, play_mode: options.play_mode, started_at: this.now(), refresh_count: 0, held_keys: new Map(), held_buttons: new Map(), reports: [], managed_artifacts: [], sample_count: 0 };
    this.sessions.set(id, session);
    const incompatible = code === 'TEST_RUNTIME_INCOMPATIBLE';
    const startAmbiguous = code === 'TEST_ACQUISITION_START_AMBIGUOUS';
    const retryable = incompatible ? 'no' as const : 'unknown' as const;
    const observedOwnership = incompatible ? 'caller-owned' : 'unknown';
    const lifecycleState = startAmbiguous ? 'start_result_ambiguous' : incompatible ? 'running_incompatible' : 'status_unavailable';
    const structured = failure({ category: 'infrastructure', code, stage: 'lifecycle status/start', summary: message, observed: { ownership: observedOwnership, lifecycle_state: lifecycleState, role_health: session.role_health, revision: this.currentRevision() }, retryable });
    const report = this.baseReport(session, transitions, false, [message], 'infrastructure', code, structured);
    report.session.ownership = startAmbiguous ? 'unknown' : incompatible ? 'caller-owned' : 'unacquired';
    report.lifecycle.state = lifecycleState;
    report.lifecycle.ownership = observedOwnership;
    report.cleanup = { attempted: false, outcome: startAmbiguous ? 'not_attempted_ownership_unknown' : 'not_owned', ...(incompatible ? { caller_playtest_preserved: true } : {}) };
    report.recommended_next_action = incompatible
      ? 'Finish the existing managed session, or explicitly stop the caller-owned playtest before starting a new scenario.'
      : startAmbiguous
        ? 'Inspect Play state and role health before deciding whether a retry is safe; do not blindly re-run the scenario.'
        : 'Inspect Studio/plugin connectivity and role health before one bounded retry.';
    return report;
  }

  private requireSession(id: string): EvidenceSession {
    const session = this.sessions.get(id); if (!session) throw new Error(`unknown evidence session: ${id}`); return session;
  }

  private relative(session: EvidenceSession): number { return Math.round((this.now() - session.started_at) * 100) / 100; }

  private async stopOwnedLifecycle(key: string, record: LifecycleRecord, instanceId: string | undefined, transitions: string[]): Promise<void> {
    if (record.owner !== 'runtime') return;
    const owner = record.owner_session_id ? this.sessions.get(record.owner_session_id) : undefined;
    if (owner) { const warnings: string[] = []; await this.releaseInputs(owner, warnings); await this.cleanupHarnesses(owner, warnings); owner.status = 'failed'; }
    await this.chrrxs.collectRuntimeLogs({ instance_id: instanceId, tail: 100, timeout_ms: 1_000 }).catch(() => undefined);
    await this.chrrxs.callJson('solo_playtest', { action: 'stop', ...(instanceId ? { instance_id: instanceId } : {}) }, 180_000);
    this.lifecycle.delete(key); transitions.push('stale_owned_playtest_stopped');
  }

  private findRuntimeErrors(value: unknown): unknown[] {
    const found: unknown[] = [];
    const visit = (item: unknown): void => {
      if (Array.isArray(item)) { for (const child of item) visit(child); return; }
      if (!item || typeof item !== 'object') return;
      const record = item as Record<string, unknown>; const level = String(record.level ?? '').toLowerCase(); const message = String(record.message ?? record.text ?? '');
      if (level.includes('error') || /(^|\W)(error|exception|traceback)(\W|$)/i.test(message)) found.push(item);
      for (const child of Object.values(record)) visit(child);
    };
    visit(value); return found.slice(0, 100);
  }
}
