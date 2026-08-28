import {
  compileAcquireRigFixture, compileAnimation, compileCleanupRigFixture, compileRigInspection,
  compileCleanupPlaytestPreview, compilePreparePlaytestPreview, compileStartAnimationPreview,
  compileStartPlaytestPreview, compileStopAnimationPreview, compileStopPlaytestPreview,
} from '../animation/compiler.js';
import { randomUUID } from 'node:crypto';
import {
  parseRigManifest,
  resolveAnimationTargets,
  RigManifestCache,
  type RigManifest,
  type ResolvedAnimation,
} from '../animation/rig.js';
import { validateAnimationDefinition } from '../animation/validator.js';
import { parseExecuteResult } from '../runtime/luau.js';
import type { AnimationDefinition, AuthorInput } from './schemas.js';
import type { ToolContext, ToolResult } from './context.js';
import { textResult } from './context.js';

const manifestCache = new RigManifestCache();

export interface PreviewSample { time: number; marker?: string }

export function resolvePreviewSamples(
  samples: Array<{ time: number } | { marker: string }>,
  definition: Pick<AnimationDefinition, 'keyframes'>,
  duration: number,
): PreviewSample[] {
  const markerTimes = new Map<string, number[]>();
  for (const keyframe of definition.keyframes) for (const marker of keyframe.markers ?? []) {
    markerTimes.set(marker.name, [...(markerTimes.get(marker.name) ?? []), keyframe.time]);
  }
  const resolved = samples.map((sample) => {
    if ('time' in sample) return { time: sample.time };
    const times = markerTimes.get(sample.marker) ?? [];
    if (times.length !== 1) throw new Error(`preview marker ${JSON.stringify(sample.marker)} must resolve exactly once (found ${times.length})`);
    return { time: times[0]!, marker: sample.marker };
  });
  for (const sample of resolved) if (sample.time < 0 || sample.time > duration) {
    throw new Error(`preview sample time ${sample.time} is outside clip duration 0..${duration}`);
  }
  for (const sample of resolved) if (sample.time > 30) throw new Error('preview samples are bounded to the first 30 seconds of a clip');
  return resolved.sort((left, right) => left.time - right.time);
}

export async function schedulePreviewCaptures<T>(
  samples: PreviewSample[],
  capture: (sample: PreviewSample, index: number) => Promise<T>,
  delay: (milliseconds: number) => Promise<void>,
  cleanup: () => Promise<void>,
  continuePlayback: boolean,
  now: () => number = () => performance.now(),
): Promise<T[]> {
  const captures: T[] = [];
  const started = now();
  try {
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      await delay(Math.max(0, sample.time * 1_000 - (now() - started)));
      captures.push(await capture(sample, index));
    }
    return captures;
  } finally {
    if (!continuePlayback) await cleanup();
  }
}

export function clearAuthorRigManifestCache(): void {
  manifestCache.clear();
}

async function inspectRig(
  targetRig: string,
  instanceId: string | undefined,
  context: ToolContext,
): Promise<RigManifest> {
  const inspectedRaw = await context.chrrxs.callJson('execute_luau', {
    code: compileRigInspection(targetRig),
    target: 'edit',
    ...(instanceId ? { instance_id: instanceId } : {}),
  }, 120_000);
  return parseRigManifest(parseExecuteResult(inspectedRaw));
}

function staleManifest(error: unknown): boolean {
  return error instanceof Error && error.message.includes('RIG_MANIFEST_STALE');
}

export async function handleAuthor(input: AuthorInput, context: ToolContext): Promise<ToolResult> {
  if (input.operation === 'acquire_fixture') {
    const raw = await context.chrrxs.callJson('execute_luau', {
      code: compileAcquireRigFixture(input.fixture), target: 'edit',
      ...(input.instance_id ? { instance_id: input.instance_id } : {}),
    }, 120_000);
    const result = parseExecuteResult(raw) as Record<string, unknown>;
    const targetRig = String(result.target_rig);
    const manifest = parseRigManifest(result.rig);
    manifestCache.set(input.instance_id, targetRig, manifest);
    return textResult({ ...result, rig: manifest });
  }
  if (input.operation === 'cleanup_fixture') {
    const raw = await context.chrrxs.callJson('execute_luau', {
      code: compileCleanupRigFixture(input.target_rig, input.artifact_names), target: 'edit',
      ...(input.instance_id ? { instance_id: input.instance_id } : {}),
    }, 120_000);
    const result = parseExecuteResult(raw) as Record<string, unknown>;
    manifestCache.delete(input.instance_id, input.target_rig);
    return textResult(result, result.success !== true);
  }
  if (input.operation === 'inspect_rig') {
    const manifest = await inspectRig(input.target_rig, input.instance_id, context);
    manifestCache.set(input.instance_id, input.target_rig, manifest);
    return textResult({ success: true, kind: 'animation', operation: 'inspect_rig', rig: manifest });
  }

  const targetRig = input.animation.target_rig;
  const validation = validateAnimationDefinition(input.animation);
  const requestedSamples = input.observation
    ? resolvePreviewSamples(input.observation.samples, input.animation, validation.duration)
    : undefined;
  let manifest = manifestCache.get(input.instance_id, targetRig);
  let cacheStatus: 'hit' | 'miss' | 'refreshed' = manifest ? 'hit' : 'miss';
  if (!manifest) {
    manifest = await inspectRig(targetRig, input.instance_id, context);
    manifestCache.set(input.instance_id, targetRig, manifest);
  }

  let resolved: ResolvedAnimation;
  try {
    resolved = resolveAnimationTargets(input.animation, manifest);
  } catch (error) {
    if (cacheStatus !== 'hit') throw error;
    manifestCache.delete(input.instance_id, targetRig);
    manifest = await inspectRig(targetRig, input.instance_id, context);
    manifestCache.set(input.instance_id, targetRig, manifest);
    cacheStatus = 'refreshed';
    resolved = resolveAnimationTargets(input.animation, manifest);
  }

  let result: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await context.chrrxs.callJson('execute_luau', {
        code: compileAnimation(
          input.observation?.context === 'playtest' ? { ...resolved.definition, preview: 'register' } : resolved.definition,
          validation.duration,
          manifest,
        ),
        target: 'edit',
        ...(input.instance_id ? { instance_id: input.instance_id } : {}),
      }, 120_000);
      result = parseExecuteResult(raw) as Record<string, unknown>;
      break;
    } catch (error) {
      if (attempt !== 0 || !staleManifest(error)) {
        if (staleManifest(error)) manifestCache.delete(input.instance_id, targetRig);
        throw error;
      }
      manifestCache.delete(input.instance_id, targetRig);
      manifest = await inspectRig(targetRig, input.instance_id, context);
      manifestCache.set(input.instance_id, targetRig, manifest);
      cacheStatus = 'refreshed';
      resolved = resolveAnimationTargets(input.animation, manifest);
    }
  }
  if (!result) throw new Error('animation authoring produced no result');

  let synchronizedObservation: Record<string, unknown> | undefined;
  let observationImages: Array<Record<string, unknown>> = [];
  if (input.observation) {
    const previewPath = String(result.preview_animation_path);
    const previewId = String(result.preview_id);
    const samples = requestedSamples!;
    const capture = async (sample: PreviewSample, index: number) => {
      const screenshot = await context.chrrxs.call('capture_screenshot', {
        format: input.observation!.format, quality: input.observation!.quality,
        ...(input.instance_id ? { instance_id: input.instance_id } : {}),
      }, 120_000);
      const images = screenshot.content.filter((block) => block.type === 'image') as Array<Record<string, unknown>>;
      if (images.length !== 1) throw new Error(`synchronized preview sample ${index} returned ${images.length} images`);
      return { sample, image: images[0]! };
    };
    const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    let captures: Array<{ sample: PreviewSample; image: Record<string, unknown> }>;
    if (input.observation.context === 'edit') {
      const startRaw = await context.chrrxs.callJson('execute_luau', {
        code: compileStartAnimationPreview(targetRig, previewPath), target: 'edit',
        ...(input.instance_id ? { instance_id: input.instance_id } : {}),
      }, 120_000);
      parseExecuteResult(startRaw);
      captures = await schedulePreviewCaptures(samples, capture, wait, async () => {
        const stopRaw = await context.chrrxs.callJson('execute_luau', {
          code: compileStopAnimationPreview(targetRig, previewId), target: 'edit',
          ...(input.instance_id ? { instance_id: input.instance_id } : {}),
        }, 120_000);
        parseExecuteResult(stopRaw);
      }, input.observation.continue_playback);
    } else {
      if (input.observation.continue_playback) throw new Error('continue_playback is not supported for managed playtest previews because the playtest is always cleaned up');
      const harnessName = `__RobloxAgentPreview_${randomUUID().replaceAll('-', '')}`;
      let playtestStarted = false;
      try {
        const prepared = await context.chrrxs.callJson('execute_luau', {
          code: compilePreparePlaytestPreview(String(result.artifact_path), harnessName), target: 'edit',
          ...(input.instance_id ? { instance_id: input.instance_id } : {}),
        }, 120_000);
        parseExecuteResult(prepared);
        await context.chrrxs.callJson('solo_playtest', {
          action: 'start', mode: 'play', ...(input.instance_id ? { instance_id: input.instance_id } : {}),
        }, 120_000);
        playtestStarted = true;
        const started = parseExecuteResult(await context.chrrxs.callJson('eval_server_runtime', {
          code: compileStartPlaytestPreview(targetRig, harnessName),
          ...(input.instance_id ? { instance_id: input.instance_id } : {}),
        }, 30_000)) as Record<string, unknown>;
        const runtimePreviewId = String(started.preview_id);
        captures = await schedulePreviewCaptures(samples, capture, wait, async () => {
          parseExecuteResult(await context.chrrxs.callJson('eval_server_runtime', {
            code: compileStopPlaytestPreview(targetRig, runtimePreviewId),
            ...(input.instance_id ? { instance_id: input.instance_id } : {}),
          }, 30_000));
        }, false);
      } finally {
        if (playtestStarted) await context.chrrxs.callJson('solo_playtest', {
          action: 'stop', ...(input.instance_id ? { instance_id: input.instance_id } : {}),
        }, 120_000).catch(() => undefined);
        const cleaned = await context.chrrxs.callJson('execute_luau', {
          code: compileCleanupPlaytestPreview(harnessName), target: 'edit',
          ...(input.instance_id ? { instance_id: input.instance_id } : {}),
        }, 120_000);
        parseExecuteResult(cleaned);
      }
    }
    observationImages = captures.map((capture) => capture.image);
    synchronizedObservation = {
      samples: captures.map((capture, index) => ({ ...capture.sample, image_content_index: index + 1 })),
      continued_playback: input.observation.continue_playback,
      managed_preview_cleanup: !input.observation.continue_playback,
      context: input.observation.context,
    };
  }

  const success = result.success === true;
  const artifactCreated = typeof result.artifact_path === 'string';
  if (artifactCreated) {
    await context.tasks.recordEvidence({
      tool: 'roblox_author', operation: 'animation',
      summary: `authored animation ${String(result.artifact_path)}`,
      success: true,
    }, 'animation');
  }
  const play = result.preview_play as Record<string, unknown> | undefined;
  if (play?.success === true) {
    await context.tasks.recordEvidence({
      tool: 'roblox_author', operation: 'animation_preview',
      summary: `played preview ${String(result.preview_animation_path)}`,
      success: true,
    }, 'animation_preview');
  }
  const response = {
    ...result,
    rig_validation: {
      target_rig: manifest.target_rig,
      rig_type: manifest.rig_type,
      manifest_cache: cacheStatus,
    },
    resolved_targets: resolved.targets,
    static_validation: validation,
    ...(synchronizedObservation ? { synchronized_observation: synchronizedObservation } : {}),
  };
  if (!observationImages.length) return textResult(response, !success);
  return { content: [{ type: 'text', text: JSON.stringify(response) }, ...observationImages], ...(!success ? { isError: true } : {}) };
}
