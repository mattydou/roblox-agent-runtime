import {
  compileAcquireRigFixture, compileAnimation, compileCleanupRigFixture, compileRigInspection,
  compileRegisterAnimationArtifact, compileStartPlaytestPreview, compileStopPlaytestPreview,
} from '../animation/compiler.js';
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
  if (input.kind === 'fixture') {
    if (input.operation === 'acquire') return handleAuthor({ kind: 'animation', operation: 'acquire_fixture', fixture: input.fixture, instance_id: input.instance_id }, context);
    if (input.operation === 'inspect') return handleAuthor({ kind: 'animation', operation: 'inspect_rig', target_rig: input.target_rig, instance_id: input.instance_id }, context);
    return handleAuthor({ kind: 'animation', operation: 'cleanup_fixture', target_rig: input.target_rig, artifact_names: input.artifact_names, instance_id: input.instance_id }, context);
  }
  if (input.operation === 'acquire_fixture') {
    const raw = await context.chrrxs.callJson('execute_luau', {
      code: compileAcquireRigFixture(input.fixture), target: 'edit',
      ...(input.instance_id ? { instance_id: input.instance_id } : {}),
    }, 120_000);
    const result = parseExecuteResult(raw) as Record<string, unknown>;
    const targetRig = String(result.target_rig);
    const manifest = parseRigManifest(result.rig);
    manifestCache.set(input.instance_id, targetRig, manifest);
    context.managedRuntime.notePersistentMutation('fixture_acquire');
    return textResult({ ...result, rig: manifest });
  }
  if (input.operation === 'cleanup_fixture') {
    const raw = await context.chrrxs.callJson('execute_luau', {
      code: compileCleanupRigFixture(input.target_rig, input.artifact_names), target: 'edit',
      ...(input.instance_id ? { instance_id: input.instance_id } : {}),
    }, 120_000);
    const result = parseExecuteResult(raw) as Record<string, unknown>;
    manifestCache.delete(input.instance_id, input.target_rig);
    if (result.deleted || (Array.isArray(result.removed_artifacts) && result.removed_artifacts.length)) context.managedRuntime.notePersistentMutation('fixture_cleanup');
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
        code: compileAnimation(resolved.definition, validation.duration, manifest),
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

  context.managedRuntime.notePersistentMutation('animation_artifact');
  const previewRequested = input.animation.preview !== 'none' || input.observation !== undefined;
  const stages = { ...(result.stages as Record<string, unknown> ?? {}) };
  let previewRegistered = false;
  let previewId: string | undefined;
  let previewPlayed = false;
  let previewError: string | undefined;
  let previewContext: string | undefined;
  let synchronizedObservation: Record<string, unknown> | undefined;
  let observationImages: Array<Record<string, unknown>> = [];
  let previewSessionId: string | undefined;
  let preservePlayback = false;
  if (previewRequested) {
    try {
      const registration = parseExecuteResult(await context.chrrxs.callJson('execute_luau', {
        code: compileRegisterAnimationArtifact(String(result.artifact_path)), target: 'edit',
        ...(input.instance_id ? { instance_id: input.instance_id } : {}),
      }, 120_000)) as Record<string, unknown>;
      previewRegistered = registration.success === true && registration.registered === true;
      previewId = typeof registration.preview_id === 'string' ? registration.preview_id : undefined;
      previewContext = 'edit';
      stages.registration = { requested: true, success: previewRegistered, context: 'edit', api: 'AnimationClipProvider.RegisterAnimationClip' };
      if (!previewRegistered || !previewId) throw new Error('edit-context animation registration returned no content ID');
      const registeredPreviewId = previewId;
      const shouldPlay = input.animation.preview === 'play' || input.observation !== undefined;
      if (shouldPlay) {
        const begin = await context.managedRuntime.begin({ instance_id: input.instance_id, play_mode: 'play', refresh_incompatible: true });
        previewSessionId = begin.session.id;
        if (!begin.success) throw new Error(`${begin.error_code ?? 'PREVIEW_SESSION_FAILED'}: ${begin.warnings.join('; ')}`);
        const played = await context.managedRuntime.evaluateRuntimeCode(
          previewSessionId, 'server', compileStartPlaytestPreview(targetRig, registeredPreviewId, true), 30_000,
        ) as Record<string, unknown>;
        previewPlayed = played.success === true && played.played === true;
        previewContext = 'server';
      }
      stages.playback = { requested: shouldPlay, success: shouldPlay ? previewPlayed : undefined, ...(shouldPlay ? { context: 'server' } : {}) };
      if (input.observation) {
        if (!previewPlayed || !previewId) throw new Error('runtime preview did not produce a playable track');
        const session = context.managedRuntime.session(previewSessionId!);
        if (!session) throw new Error('managed preview session disappeared');
        if (input.observation.continue_playback && session.ownership !== 'caller-owned') throw new Error('continue_playback requires a compatible caller-owned playtest');
        preservePlayback = input.observation.continue_playback;
        const capture = async (sample: PreviewSample, index: number) => {
          const screenshot = await context.chrrxs.call('capture_screenshot', {
            format: input.observation!.format, quality: input.observation!.quality,
            ...(input.instance_id ? { instance_id: input.instance_id } : {}),
          }, 120_000);
          const images = screenshot.content.filter((block) => block.type === 'image') as Array<Record<string, unknown>>;
          if (images.length !== 1) throw new Error(`synchronized preview sample ${index} returned ${images.length} images`);
          return { sample, image: images[0]! };
        };
        const captures = await schedulePreviewCaptures(requestedSamples!, capture,
          (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), async () => {
            if (!input.observation!.continue_playback) await context.managedRuntime.evaluateRuntimeCode(previewSessionId!, 'server', compileStopPlaytestPreview(targetRig, registeredPreviewId), 30_000);
          }, input.observation.continue_playback);
        observationImages = captures.map((captureItem) => captureItem.image);
        synchronizedObservation = {
          samples: captures.map((captureItem, index) => ({ ...captureItem.sample, image_content_index: index + 1 })),
          continued_playback: input.observation.continue_playback,
          managed_preview_cleanup: !input.observation.continue_playback,
          requested_context: input.observation.context,
          context: 'server', track_starts: 1,
        };
        stages.observation = { requested: true, success: true, requested_context: input.observation.context, context: 'server', samples: captures.length };
      } else if (previewPlayed && previewSessionId) {
        await context.managedRuntime.evaluateRuntimeCode(previewSessionId, 'server', compileStopPlaytestPreview(targetRig, registeredPreviewId), 30_000);
      }
    } catch (error) {
      previewError = error instanceof Error ? error.message : String(error);
      stages.registration = stages.registration ?? { requested: true, success: false, context: previewContext ?? 'managed_runtime', error: previewError };
      stages.playback = stages.playback ?? { requested: input.animation.preview === 'play' || input.observation !== undefined, success: false, error: previewError };
      if (input.observation) stages.observation = { requested: true, success: false, error: previewError };
    } finally {
      if (previewSessionId && previewId && !preservePlayback) {
        try { await context.managedRuntime.evaluateRuntimeCode(previewSessionId, 'server', compileStopPlaytestPreview(targetRig, previewId), 30_000); }
        catch (error) { previewError = `${previewError ? `${previewError}; ` : ''}track cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
      }
      if (previewSessionId) {
        try {
          const cleanup = await context.managedRuntime.finish(previewSessionId);
          stages.cleanup = { requested: true, success: cleanup.success, details: cleanup.cleanup };
          if (!cleanup.success) previewError = `${previewError ? `${previewError}; ` : ''}managed runtime cleanup was partial`;
        } catch (error) {
          previewError = `${previewError ? `${previewError}; ` : ''}managed runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          stages.cleanup = { requested: true, success: false, error: previewError };
        }
      } else if (previewRequested) stages.cleanup = { requested: false, success: true };
    }
  }

  const playbackRequested = input.animation.preview === 'play' || input.observation !== undefined;
  const success = result.success === true && (!previewRequested || (!previewError && previewRegistered && (!playbackRequested || previewPlayed)));
  const artifactCreated = typeof result.artifact_path === 'string';
  if (artifactCreated) {
    await context.tasks.recordEvidence({
      tool: 'roblox_author', operation: 'animation',
      category: 'artifact', source: 'runtime',
      summary: `authored animation ${String(result.artifact_path)}`,
      success: true,
    }, 'animation');
  }
  if (previewRequested) {
    await context.tasks.recordEvidence({
      tool: 'roblox_author', operation: 'animation_registration', category: 'preview', source: 'runtime',
      summary: `${previewRegistered ? 'registered' : 'failed to register'} Studio-local animation ${String(result.artifact_path)}`,
      success: previewRegistered,
    }, previewRegistered ? 'animation_preview' : undefined);
  }
  if (previewPlayed) {
    await context.tasks.recordEvidence({
      tool: 'roblox_author', operation: 'animation_preview',
      category: 'preview', source: 'runtime', summary: `played runtime preview for ${String(result.artifact_path)}`,
      success: true,
    }, 'animation_preview');
  }
  if (observationImages.length) {
    await context.tasks.recordEvidence({
      tool: 'roblox_author', operation: 'animation_observation', category: 'visual', source: 'runtime',
      summary: `captured ${observationImages.length} synchronized animation frame(s)`, success: true,
    }, 'screenshot');
  }
  if (previewSessionId) {
    const cleanupStage = stages.cleanup as Record<string, unknown> | undefined;
    const cleanupSuccess = cleanupStage?.success === true;
    await context.tasks.recordEvidence({
      tool: 'roblox_author', operation: 'animation_cleanup', category: 'cleanup', source: 'runtime',
      summary: cleanupSuccess ? 'managed animation preview cleanup verified' : 'managed animation preview cleanup partial', success: cleanupSuccess,
    }, cleanupSuccess ? 'cleanup' : undefined);
  }
  const response = {
    ...result,
    success,
    stages,
    preview_registered: previewRegistered,
    preview_id: previewId,
    preview_id_scope: previewId ? 'studio_session' : 'none',
    preview_play: { requested: input.animation.preview === 'play' || Boolean(input.observation), success: previewPlayed, ...(previewError ? { error: previewError } : {}) },
    preview_execution_context: previewContext,
    published_animation_id: null,
    deployment_ready: false,
    rig_validation: {
      target_rig: manifest.target_rig,
      rig_type: manifest.rig_type,
      manifest_cache: cacheStatus,
    },
    resolved_targets: resolved.targets,
    static_validation: validation,
    ...(synchronizedObservation ? { synchronized_observation: synchronizedObservation } : {}),
  };
  if (!observationImages.length) return { ...textResult(response, !success), telemetry: { animation_artifact_success: 1, animation_preview_success: previewRequested ? Number(success) : 0, preview_execution_context: previewContext, synchronized_animation_samples: 0 } };
  return { content: [{ type: 'text', text: JSON.stringify(response) }, ...observationImages], ...(!success ? { isError: true } : {}), telemetry: { animation_artifact_success: 1, animation_preview_success: Number(success), preview_execution_context: previewContext, synchronized_animation_samples: observationImages.length } };
}
