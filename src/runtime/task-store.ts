import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type TaskStepStatus = 'pending' | 'in_progress' | 'completed';
export type RequirementStatus = 'pending' | 'completed';

export interface TaskStep {
  id: string;
  description: string;
  status: TaskStepStatus;
}

export interface TaskRequirement {
  id: string;
  type: string;
  description?: string;
  status: RequirementStatus;
  evidence?: string;
}

export interface TaskEvidence {
  timestamp: string;
  tool: string;
  operation: string;
  summary: string;
  success: boolean;
  category?: 'artifact' | 'preview' | 'visual' | 'lifecycle' | 'observation' | 'behavior' | 'cleanup' | 'implementation' | 'infrastructure' | 'readiness' | 'setup' | 'interaction';
  source?: 'runtime' | 'caller';
}

export interface TaskRecord {
  id: string;
  goal: string;
  status: 'active' | 'completed';
  enforcement: 'advisory' | 'enforced';
  created_at: string;
  updated_at: string;
  completed_at?: string;
  plan: TaskStep[];
  requirements: TaskRequirement[];
  completed_operations: TaskEvidence[];
  observations: Array<{ timestamp: string; text: string }>;
  validation_results: Array<{ timestamp: string; name: string; success: boolean; details?: string; source: 'caller' }>;
}

export interface BeginTaskInput {
  task_id?: string;
  goal: string;
  plan?: TaskStep[];
  requirements?: TaskRequirement[];
  enforcement?: 'advisory' | 'enforced';
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export class TaskStore {
  readonly tasksDir: string;
  readonly currentFile: string;

  constructor(readonly runtimeDir: string) {
    this.tasksDir = path.join(runtimeDir, 'tasks');
    this.currentFile = path.join(runtimeDir, 'current-task.json');
  }

  async begin(input: BeginTaskInput): Promise<TaskRecord> {
    const id = input.task_id ?? randomUUID();
    if (!TASK_ID.test(id)) throw new Error('task_id must be 1-80 safe filename characters');
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id,
      goal: input.goal,
      status: 'active',
      enforcement: input.enforcement ?? 'advisory',
      created_at: now,
      updated_at: now,
      plan: (input.plan ?? []).map((step) => ({ ...step, status: step.status ?? 'pending' })),
      requirements: (input.requirements ?? []).map((requirement) => ({
        ...requirement,
        status: requirement.status ?? 'pending',
      })),
      completed_operations: [],
      observations: [],
      validation_results: [],
    };
    this.assertUniqueIds(task);
    await this.save(task);
    await this.atomicWrite(this.currentFile, JSON.stringify({ task_id: id }, null, 2));
    return task;
  }

  async currentId(): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(this.currentFile, 'utf8')) as { task_id?: unknown };
      return typeof parsed.task_id === 'string' ? parsed.task_id : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async current(): Promise<TaskRecord | null> {
    const id = await this.currentId();
    return id ? this.load(id) : null;
  }

  async load(id: string): Promise<TaskRecord> {
    if (!TASK_ID.test(id)) throw new Error('invalid task id');
    try {
      const parsed = JSON.parse(await readFile(path.join(this.tasksDir, `${id}.json`), 'utf8')) as Partial<TaskRecord>;
      const now = new Date().toISOString();
      return {
        id: String(parsed.id ?? id),
        goal: String(parsed.goal ?? ''),
        status: parsed.status === 'completed' ? 'completed' : 'active',
        enforcement: parsed.enforcement === 'enforced' ? 'enforced' : 'advisory',
        created_at: String(parsed.created_at ?? now),
        updated_at: String(parsed.updated_at ?? parsed.created_at ?? now),
        ...(typeof parsed.completed_at === 'string' ? { completed_at: parsed.completed_at } : {}),
        plan: Array.isArray(parsed.plan) ? parsed.plan : [],
        requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [],
        completed_operations: Array.isArray(parsed.completed_operations)
          ? parsed.completed_operations.map((item) => ({ ...item, source: item.source === 'runtime' ? 'runtime' as const : 'caller' as const }))
          : [],
        observations: Array.isArray(parsed.observations) ? parsed.observations : [],
        validation_results: Array.isArray(parsed.validation_results)
          ? parsed.validation_results.map((item) => ({ ...item, source: 'caller' as const }))
          : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`task not found: ${id}`);
      throw error;
    }
  }

  async setPlan(plan?: TaskStep[], requirements?: TaskRequirement[]): Promise<TaskRecord> {
    const task = await this.requireCurrent();
    if (plan) task.plan = plan;
    if (requirements) task.requirements = requirements;
    this.assertUniqueIds(task);
    await this.save(task);
    return task;
  }

  async markStep(stepId: string, status: TaskStepStatus): Promise<TaskRecord> {
    const task = await this.requireCurrent();
    const step = task.plan.find((item) => item.id === stepId);
    if (!step) throw new Error(`unknown plan step: ${stepId}`);
    step.status = status;
    await this.save(task);
    return task;
  }

  async recordObservation(text: string): Promise<TaskRecord> {
    const task = await this.requireCurrent();
    task.observations.push({ timestamp: new Date().toISOString(), text });
    await this.save(task);
    return task;
  }

  async recordValidation(name: string, success: boolean, details?: string, requirementId?: string): Promise<TaskRecord> {
    const task = await this.requireCurrent();
    task.validation_results.push({ timestamp: new Date().toISOString(), name, success, source: 'caller', ...(details ? { details } : {}) });
    if (success && requirementId) this.satisfyRequirement(task, (item) => item.id === requirementId, details ?? name);
    await this.save(task);
    return task;
  }

  async recordEvidence(evidence: Omit<TaskEvidence, 'timestamp'>, capability?: string): Promise<void> {
    const task = await this.current();
    if (!task || task.status !== 'active') return;
    task.completed_operations.push({ timestamp: new Date().toISOString(), ...evidence });
    if (evidence.success && capability) {
      this.satisfyRequirement(task, (item) => item.type === capability, evidence.summary);
    }
    if (evidence.success) {
      this.satisfyRequirement(task, (item) => item.type === 'artifact' && ['roblox_edit', 'roblox_author'].includes(evidence.tool), evidence.summary);
      if (capability === 'behavioral_test') this.satisfyRequirement(task, (item) => item.type === 'test' || item.type === 'behavioral_test', evidence.summary);
    }
    await this.save(task);
  }

  async complete(): Promise<{ completed: boolean; task: TaskRecord; remaining: string[] }> {
    const task = await this.requireCurrent();
    const remaining = [
      ...task.plan.filter((step) => step.status !== 'completed').map((step) => `step:${step.id}`),
      ...task.requirements.filter((requirement) => requirement.status !== 'completed').map((requirement) => `requirement:${requirement.id}`),
    ];
    if (remaining.length && task.enforcement === 'enforced') return { completed: false, task, remaining };
    task.status = 'completed';
    task.completed_at = new Date().toISOString();
    await this.save(task);
    return { completed: true, task, remaining };
  }

  evidenceState(task: TaskRecord): Record<string, unknown> {
    const runtime = task.completed_operations.filter((item) => item.source === 'runtime');
    const behavior = runtime.filter((item) => item.category === 'behavior');
    return {
      implementation_evidence: runtime.some((item) => ['artifact', 'implementation'].includes(item.category ?? '')),
      lifecycle_log_smoke: runtime.some((item) => item.category === 'lifecycle' && item.success),
      objective_behavior: behavior.some((item) => !item.success) ? 'failed' : behavior.some((item) => item.success) ? 'validated' : 'not_run',
      managed_cleanup_verified: runtime.some((item) => item.category === 'cleanup' && item.success),
      visual_evidence: runtime.some((item) => item.category === 'visual' && item.success),
      caller_authored_validations: task.validation_results.length,
    };
  }

  private async requireCurrent(): Promise<TaskRecord> {
    const task = await this.current();
    if (!task) throw new Error('no active task; call roblox_task action="begin" first');
    return task;
  }

  private satisfyRequirement(task: TaskRecord, predicate: (item: TaskRequirement) => boolean, evidence: string): void {
    for (const requirement of task.requirements) {
      if (predicate(requirement) && requirement.status !== 'completed') {
        requirement.status = 'completed';
        requirement.evidence = evidence;
      }
    }
  }

  private assertUniqueIds(task: TaskRecord): void {
    for (const [label, items] of [['plan step', task.plan], ['requirement', task.requirements]] as const) {
      const ids = new Set<string>();
      for (const item of items) {
        if (!item.id || ids.has(item.id)) throw new Error(`${label} ids must be non-empty and unique`);
        ids.add(item.id);
      }
    }
  }

  private async save(task: TaskRecord): Promise<void> {
    task.updated_at = new Date().toISOString();
    await this.atomicWrite(path.join(this.tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  private async atomicWrite(target: string, contents: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, 'utf8');
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await unlink(target).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      await rename(temporary, target);
    }
  }
}
