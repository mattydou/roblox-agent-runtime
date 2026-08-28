import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/runtime/task-store.js';

describe('TaskStore', () => {
  it('allows advisory completion but enforces explicitly strict tasks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-task-'));
    const store = new TaskStore(root);
    await store.begin({
      task_id: 'fireball-benchmark',
      goal: 'build and validate an ability',
      plan: [{ id: 'author', description: 'author animation', status: 'pending' }],
      requirements: [{ id: 'clip', type: 'animation', status: 'pending' }],
    });
    const advisory = await store.complete();
    expect(advisory.completed).toBe(true);
    expect(advisory.remaining).toEqual(['step:author', 'requirement:clip']);

    await store.begin({
      task_id: 'fireball-enforced', goal: 'strict research run', enforcement: 'enforced',
      plan: [{ id: 'author', description: 'author animation', status: 'pending' }],
      requirements: [{ id: 'clip', type: 'animation', status: 'pending' }],
    });
    const blocked = await store.complete();
    expect(blocked.completed).toBe(false);

    await store.markStep('author', 'completed');
    await store.recordEvidence({ tool: 'roblox_author', operation: 'animation', summary: 'clip created', success: true }, 'animation');
    const completed = await store.complete();
    expect(completed.completed).toBe(true);

    const saved = JSON.parse(await readFile(path.join(root, 'tasks', 'fireball-enforced.json'), 'utf8'));
    expect(saved.status).toBe('completed');
    expect(saved.requirements[0].evidence).toBe('clip created');
  });

  it('does not infer or satisfy capabilities after failed evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-task-'));
    const store = new TaskStore(root);
    await store.begin({ goal: 'test', requirements: [{ id: 'preview', type: 'animation_preview', status: 'pending' }] });
    await store.recordEvidence({ tool: 'roblox_author', operation: 'preview', summary: 'failed', success: false }, 'animation_preview');
    expect((await store.current())?.requirements[0]?.status).toBe('pending');
  });

  it('migrates existing task JSON and supports optional manual controls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-task-'));
    await mkdir(path.join(root, 'tasks'), { recursive: true });
    await writeFile(path.join(root, 'current-task.json'), JSON.stringify({ task_id: 'legacy' }));
    await writeFile(path.join(root, 'tasks', 'legacy.json'), JSON.stringify({
      id: 'legacy', goal: 'old task', status: 'active', created_at: '2025-01-01T00:00:00.000Z',
      plan: [{ id: 'manual', description: 'optional', status: 'pending' }],
    }));
    const store = new TaskStore(root);
    const loaded = await store.current();
    expect(loaded).toMatchObject({ enforcement: 'advisory', requirements: [], completed_operations: [] });
    await store.markStep('manual', 'completed');
    await store.recordObservation('kept for research');
    await store.recordValidation('manual check', true);
    expect(await store.current()).toMatchObject({
      plan: [{ status: 'completed' }], observations: [{ text: 'kept for research' }], validation_results: [{ name: 'manual check' }],
    });
  });

  it('satisfies generic artifact and test requirements from successful public evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'roblox-agent-task-'));
    const store = new TaskStore(root);
    await store.begin({ goal: 'automatic evidence', requirements: [
      { id: 'artifact', type: 'artifact', status: 'pending' }, { id: 'test', type: 'test', status: 'pending' },
    ] });
    await store.recordEvidence({ tool: 'roblox_edit', operation: 'batch', summary: 'edited', success: true });
    await store.recordEvidence({ tool: 'roblox_test', operation: 'solo_stop', summary: 'tested', success: true });
    expect((await store.current())?.requirements).toMatchObject([
      { status: 'completed', evidence: 'edited' }, { status: 'completed', evidence: 'tested' },
    ]);
  });
});
