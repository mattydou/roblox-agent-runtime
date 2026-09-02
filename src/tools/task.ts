import type { TaskInput } from './schemas.js';
import type { TaskRecord } from '../runtime/task-store.js';
import type { ToolContext, ToolResult } from './context.js';
import { textResult } from './context.js';

function summary(task: TaskRecord) {
  return {
    active: task.status === 'active',
    task_id: task.id,
    goal: task.goal,
    status: task.status,
    enforcement: task.enforcement,
    plan: {
      total: task.plan.length,
      completed: task.plan.filter((step) => step.status === 'completed').length,
    },
    requirements: {
      total: task.requirements.length,
      completed: task.requirements.filter((requirement) => requirement.status === 'completed').length,
    },
    evidence_count: task.completed_operations.length,
    validation_count: task.validation_results.length,
    updated_at: task.updated_at,
  };
}

function acknowledgement(action: string, task: Parameters<typeof summary>[0]) {
  return { ok: true, action, ...summary(task) };
}

export async function handleTask(input: TaskInput, context: ToolContext): Promise<ToolResult> {
  switch (input.action) {
    case 'begin':
      return textResult(acknowledgement('begin', await context.tasks.begin({
        goal: input.goal,
        ...(input.task_id ? { task_id: input.task_id } : {}),
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.requirements ? { requirements: input.requirements } : {}),
        enforcement: input.enforcement,
      })));
    case 'set_plan':
      return textResult(acknowledgement('set_plan', await context.tasks.setPlan(input.plan, input.requirements)));
    case 'mark_step':
      return textResult(acknowledgement('mark_step', await context.tasks.markStep(input.step_id, input.status)));
    case 'record_observation':
      return textResult(acknowledgement('record_observation', await context.tasks.recordObservation(input.text)));
    case 'record_validation':
      return textResult(acknowledgement('record_validation', await context.tasks.recordValidation(
        input.name,
        input.success,
        input.details,
        input.requirement_id,
      )));
    case 'status': {
      const task = await context.tasks.current();
      return textResult(task ? (input.detail === 'full' ? task : summary(task)) : { active: false, message: 'no active task' });
    }
    case 'complete': {
      const completion = await context.tasks.complete();
      const response = {
        completed: completion.completed,
        task_id: completion.task.id,
        enforcement: completion.task.enforcement,
        remaining_advisory: completion.remaining,
        evidence_state: context.tasks.evidenceState(completion.task),
        ...(input.detail === 'full' ? { task: completion.task } : { summary: summary(completion.task) }),
      };
      return textResult(response, !completion.completed);
    }
  }
}
