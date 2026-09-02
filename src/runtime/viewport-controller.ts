import type { ChrrxsAdapter } from '../chrrxs/adapter.js';
import type { ToolResult } from '../tools/context.js';
import type { ObserveInput } from '../tools/schemas.js';
import { compileCameraOperation } from './camera-luau.js';
import { failure, type StructuredFailure } from './failure.js';
import { parseExecuteResult } from './luau.js';

type ViewsInput = Extract<ObserveInput, { mode: 'views' }>;
type CameraSnapshot = { camera_type: string; cframe: number[]; focus: number[]; field_of_view: number };

export const VIEW_PRESETS = {
  front: { azimuth: 0, elevation: 0 }, rear: { azimuth: 180, elevation: 0 },
  left: { azimuth: -90, elevation: 0 }, right: { azimuth: 90, elevation: 0 },
  overhead: { azimuth: 0, elevation: 89.5 }, front_right: { azimuth: 45, elevation: 25 },
  front_left: { azimuth: -45, elevation: 25 }, rear_right: { azimuth: 135, elevation: 25 },
  rear_left: { azimuth: -135, elevation: 25 }, lower_front: { azimuth: 0, elevation: -20 },
} as const;

function compactError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000); }

function rolesIn(value: unknown): Set<string> {
  const roles = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && /^(edit|server|client-[1-9][0-9]*)$/.test(item)) roles.add(item);
    else if (Array.isArray(item)) for (const child of item) visit(child);
    else if (item && typeof item === 'object') for (const child of Object.values(item as Record<string, unknown>)) visit(child);
  };
  visit(value); return roles;
}

function screenshotMetadata(result: Awaited<ReturnType<ChrrxsAdapter['call']>>): Record<string, unknown> {
  for (const block of result.content) if (block.type === 'text') {
    try {
      const value = JSON.parse(block.text);
      if (value && typeof value === 'object') return value as Record<string, unknown>;
    } catch { /* Chrrxs text is optional metadata. */ }
  }
  return {};
}

export class ViewportController {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly active = new Map<string, { context: 'edit' | 'client-1'; instance_id?: string; snapshot: CameraSnapshot }>();

  constructor(readonly chrrxs: ChrrxsAdapter) {}

  async capture(input: ViewsInput): Promise<ToolResult> {
    const key = `${input.instance_id ?? '<single>'}:${input.context}`;
    const release = await this.acquire(key);
    const images: Array<Record<string, unknown>> = [];
    const captures: Array<Record<string, unknown>> = [];
    let snapshot: CameraSnapshot | undefined;
    let restoreAttempted = false;
    let restoreSuccess = false;
    let operationFailure: StructuredFailure | undefined;
    let target: Record<string, unknown> = {};
    try {
      const connected = await this.chrrxs.callJson('get_connected_instances');
      const roles = rolesIn(connected);
      if (input.context === 'edit' && roles.has('client-1')) {
        operationFailure = failure({ category: 'observation', code: 'EDIT_CAPTURE_UNAVAILABLE_DURING_PLAYTEST', stage: 'camera context routing', summary: 'An active runtime client would cause Chrrxs to capture client-1 instead of the requested edit viewport.', observed: { roles: [...roles] }, retryable: 'no' });
        return this.result(input, target, captures, images, false, false, false, operationFailure);
      }
      if (input.context === 'client-1' && !roles.has('client-1')) {
        operationFailure = failure({ category: 'observation', code: 'CONTROLLED_CAPTURE_CONTEXT_UNSUPPORTED', stage: 'camera context routing', summary: 'client-1 is not available for controlled capture.', observed: { roles: [...roles] }, retryable: 'no' });
        return this.result(input, target, captures, images, false, false, false, operationFailure);
      }
      const begun = await this.evaluate(input.context, input.instance_id, compileCameraOperation({
        operation: 'snapshot', ...(input.target_path ? { target_path: input.target_path } : { center: input.center }),
        ...(input.radius === undefined ? {} : { radius: input.radius }), padding: input.padding, field_of_view: input.field_of_view,
      })) as { snapshot: CameraSnapshot; target: Record<string, unknown> };
      snapshot = begun.snapshot; target = begun.target;
      this.active.set(key, { context: input.context, instance_id: input.instance_id, snapshot });
      const center = target.center as [number, number, number];
      const targetBasis = target.basis_components as number[];
      const basis = input.basis === 'target' ? targetBasis : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
      const radius = Number(target.radius);
      for (let index = 0; index < input.views.length; index += 1) {
        const requested = input.views[index]!;
        const angles = 'preset' in requested ? VIEW_PRESETS[requested.preset] : requested;
        const viewId = requested.id ?? ('preset' in requested ? requested.preset : `view-${index + 1}`);
        try {
          const applied = await this.evaluate(input.context, input.instance_id, compileCameraOperation({
            operation: 'apply', center, basis_components: basis, radius, azimuth: angles.azimuth, elevation: angles.elevation,
            field_of_view: input.field_of_view, settle_frames: input.settle_frames, settle_timeout_ms: input.settle_timeout_ms,
          })) as Record<string, unknown>;
          const screenshot = await this.chrrxs.call('capture_screenshot', {
            format: input.format, quality: input.quality, ...(input.instance_id ? { instance_id: input.instance_id } : {}),
          }, 120_000);
          const blocks = screenshot.content.filter((block) => block.type === 'image') as Array<Record<string, unknown>>;
          if (blocks.length !== 1) throw new Error(`controlled capture returned ${blocks.length} images`);
          images.push(blocks[0]!);
          const metadata = screenshotMetadata(screenshot);
          captures.push({ index, view_id: viewId, ...('preset' in requested ? { preset: requested.preset } : {}), azimuth: angles.azimuth, elevation: angles.elevation, success: true, image_index: images.length, camera: applied.camera, width: metadata.width, height: metadata.height, format: metadata.format ?? input.format, quality: metadata.quality ?? input.quality });
        } catch (error) {
          const summary = compactError(error);
          captures.push({ index, view_id: viewId, ...('preset' in requested ? { preset: requested.preset } : {}), azimuth: angles.azimuth, elevation: angles.elevation, success: false, error_code: 'CONTROLLED_CAPTURE_FAILED', observed: summary });
          operationFailure ??= failure({ category: 'observation', code: 'CONTROLLED_CAPTURE_FAILED', stage: 'camera capture', summary: `View ${viewId} did not capture successfully: ${summary}`, observed: { index, view_id: viewId }, retryable: 'unknown' });
          if (/disconnect|proxy|transport|CAMERA_RENDER_SETTLE_TIMEOUT|CURRENT_CAMERA/i.test(summary)) {
            for (let skipped = index + 1; skipped < input.views.length; skipped += 1) {
              const later = input.views[skipped]!;
              captures.push({ index: skipped, view_id: later.id ?? ('preset' in later ? later.preset : `view-${skipped + 1}`), success: false, skipped_reason: 'camera ownership or transport is no longer healthy' });
            }
            break;
          }
        }
      }
    } catch (error) {
      const summary = compactError(error);
      operationFailure = failure({ category: 'observation', code: summary.includes('WRONG_CLASS') ? 'CONTROLLED_CAPTURE_TARGET_WRONG_CLASS' : 'CONTROLLED_CAPTURE_FAILED', stage: snapshot ? 'camera apply' : 'camera snapshot', summary, retryable: summary.includes('WRONG_CLASS') ? 'no' : 'unknown' });
    } finally {
      if (snapshot && (input.restore_viewport || operationFailure)) {
        restoreAttempted = true;
        try {
          await this.evaluate(input.context, input.instance_id, compileCameraOperation({ operation: 'restore', snapshot }));
          restoreSuccess = true;
        } catch (error) {
          const summary = compactError(error);
          operationFailure = failure({ category: 'cleanup', code: 'CAMERA_RESTORE_FAILED', stage: 'camera restore', summary: `Viewport restoration failed: ${summary}`, observed: operationFailure, retryable: 'unknown' });
        }
      }
      this.active.delete(key);
      release();
    }
    const success = !operationFailure && captures.length === input.views.length && captures.every((item) => item.success === true);
    return this.result(input, target, captures, images, success, restoreAttempted, restoreSuccess, operationFailure);
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map(async (item) => {
      try { await this.evaluate(item.context, item.instance_id, compileCameraOperation({ operation: 'restore', snapshot: item.snapshot })); } catch { /* best effort */ }
    }));
    this.active.clear();
  }

  private result(input: ViewsInput, target: Record<string, unknown>, captures: Array<Record<string, unknown>>, images: Array<Record<string, unknown>>, success: boolean, restoreAttempted: boolean, restoreSuccess: boolean, failed?: StructuredFailure): ToolResult {
    const manifest = { success, context: input.context, target: { path: target.path ?? input.target_path, center: target.center ?? input.center, radius: target.radius ?? input.radius, basis: input.basis }, restore: { requested: input.restore_viewport, attempted: restoreAttempted, success: restoreAttempted ? restoreSuccess : success && !input.restore_viewport }, captures, ...(failed ? { failure: failed, failure_kind: failed.category === 'cleanup' ? 'infrastructure' : 'behavioral', error_code: failed.code } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(manifest) }, ...images], ...(!success ? { isError: true } : {}) };
  }

  private async evaluate(context: 'edit' | 'client-1', instanceId: string | undefined, code: string): Promise<unknown> {
    const tool = context === 'edit' ? 'execute_luau' : 'eval_client_runtime';
    const raw = await this.chrrxs.callJson(tool, { code, ...(context === 'edit' ? { target: 'edit' } : { target: 'client-1' }), ...(instanceId ? { instance_id: instanceId } : {}) }, 30_000);
    return parseExecuteResult(raw);
  }

  private async acquire(key: string): Promise<() => void> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => current);
    this.locks.set(key, queued);
    await prior;
    return () => { release(); if (this.locks.get(key) === queued) this.locks.delete(key); };
  }
}
