import { z } from 'zod';
import type { AnimationDefinition } from '../tools/schemas.js';

const rigAnimatedPartSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  relative_path: z.string().min(1),
  parent_path: z.string().min(1).optional(),
  via_joint_name: z.string().min(1).optional(),
  via_joint_path: z.string().min(1).optional(),
  via_joint_class: z.string().min(1).optional(),
  depth: z.number().int().min(0),
  aliases: z.array(z.string().min(1)).min(1),
}).strict();

const rigJointSchema = z.object({
  name: z.string().min(1),
  class_name: z.string().min(1),
  path: z.string().min(1),
  relative_path: z.string().min(1),
  part0_path: z.string().min(1),
  part1_path: z.string().min(1),
  animated_part_path: z.string().min(1).optional(),
  animatable: z.boolean(),
}).strict();

export const rigManifestSchema = z.object({
  target_rig: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  rig_type: z.string().min(1),
  controller_class: z.string().min(1).optional(),
  controller_path: z.string().min(1).optional(),
  roots: z.array(z.string().min(1)).min(1),
  animated_parts: z.array(rigAnimatedPartSchema).min(1),
  joints: z.array(rigJointSchema).min(1),
}).strict();

export type RigManifest = z.infer<typeof rigManifestSchema>;

export class RigManifestCache {
  private readonly manifests = new Map<string, RigManifest>();

  get(instanceId: string | undefined, targetRig: string): RigManifest | undefined {
    return this.manifests.get(this.key(instanceId, targetRig));
  }

  set(instanceId: string | undefined, targetRig: string, manifest: RigManifest): void {
    this.manifests.set(this.key(instanceId, targetRig), manifest);
  }

  delete(instanceId: string | undefined, targetRig: string): void {
    this.manifests.delete(this.key(instanceId, targetRig));
  }

  clear(): void {
    this.manifests.clear();
  }

  private key(instanceId: string | undefined, targetRig: string): string {
    return `${instanceId ?? '<single>'}\u0000${targetRig}`;
  }
}

export function parseRigManifest(value: unknown): RigManifest {
  const parsed = rigManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Malformed rig inspection result: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export interface ResolvedAnimation {
  definition: AnimationDefinition;
  targets: Array<{ requested: string; animated_part: string }>;
}

export function resolveAnimationTargets(definition: AnimationDefinition, manifest: RigManifest): ResolvedAnimation {
  const candidates = new Map<string, Set<string>>();
  for (const part of manifest.animated_parts) {
    for (const alias of part.aliases) {
      const matches = candidates.get(alias) ?? new Set<string>();
      matches.add(part.path);
      candidates.set(alias, matches);
    }
  }

  const resolved = new Map<string, string>();
  const validNames = [...new Set(manifest.animated_parts.flatMap((part) => [part.name, part.relative_path]))]
    .sort((left, right) => left.localeCompare(right));
  const resolve = (requested: string): string => {
    const cached = resolved.get(requested);
    if (cached) return cached;
    const matches = candidates.get(requested);
    if (!matches?.size) {
      const suffix = validNames.length > 40 ? `, ... (${validNames.length - 40} more)` : '';
      throw new Error(
        `animation target ${JSON.stringify(requested)} is not present in authoritative rig ${manifest.target_rig}; `
        + `valid animated parts/joints: ${validNames.slice(0, 40).join(', ')}${suffix}. `
        + 'Call roblox_author with operation="inspect_rig" to inspect canonical targets.',
      );
    }
    if (matches.size !== 1) {
      throw new Error(
        `animation target ${JSON.stringify(requested)} is ambiguous in authoritative rig ${manifest.target_rig}; `
        + `use one of these canonical part paths: ${[...matches].sort().join(', ')}`,
      );
    }
    const selected = [...matches][0]!;
    resolved.set(requested, selected);
    return selected;
  };

  const keyframes = definition.keyframes.map((keyframe, keyframeIndex) => {
    const seen = new Set<string>();
    const poses = keyframe.poses.map((pose) => {
      const animatedPart = resolve(pose.joint);
      if (seen.has(animatedPart)) {
        throw new Error(
          `keyframe ${keyframeIndex} targets ${animatedPart} more than once through different aliases`,
        );
      }
      seen.add(animatedPart);
      return { ...pose, joint: animatedPart };
    });
    return { ...keyframe, poses };
  });

  return {
    definition: { ...definition, target_rig: manifest.target_rig, keyframes },
    targets: [...resolved].map(([requested, animated_part]) => ({ requested, animated_part })),
  };
}
