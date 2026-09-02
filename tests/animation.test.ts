import { describe, expect, it } from 'vitest';
import {
  compileAcquireRigFixture, compileAnimation, compileCleanupRigFixture, compileRigInspection,
  compileRegisterAnimationArtifact, compileStartPlaytestPreview,
} from '../src/animation/compiler.js';
import { resolveAnimationTargets, type RigManifest } from '../src/animation/rig.js';
import { validateAnimationDefinition } from '../src/animation/validator.js';
import { animationDefinitionSchema } from '../src/tools/schemas.js';
import { resolvePreviewSamples, schedulePreviewCaptures } from '../src/tools/author.js';

function animation(joint = 'RightShoulder', overrides: Record<string, unknown> = {}) {
  return animationDefinitionSchema.parse({
    target_rig: 'game.Workspace.Rig',
    name: 'Cast',
    keyframes: [
      { time: 0, poses: [{ joint }] },
      { time: 0.4, poses: [{ joint, rotation_degrees: [0, 0, -45] }], markers: [{ name: 'Release' }] },
    ],
    ...overrides,
  });
}

function manifest(
  rigType: string,
  parts: Array<{ name: string; parent?: string; joint?: string; jointClass?: string }>,
): RigManifest {
  const rig = `game.Workspace.${rigType}Rig`;
  const animatedParts = parts.map((part, index) => {
    const path = `${rig}.${part.name.replaceAll(' ', '')}`;
    const jointPath = part.joint ? `${path}.${part.joint.replaceAll(' ', '')}` : undefined;
    return {
      name: part.name,
      path,
      relative_path: part.name.replaceAll(' ', ''),
      ...(part.parent ? { parent_path: `${rig}.${part.parent.replaceAll(' ', '')}` } : {}),
      ...(part.joint ? {
        via_joint_name: part.joint,
        via_joint_path: jointPath,
        via_joint_class: part.jointClass ?? 'Motor6D',
      } : {}),
      depth: index,
      aliases: [...new Set([part.name, part.name.replaceAll(' ', ''), path, ...(part.joint ? [part.joint, jointPath!] : [])])],
    };
  });
  return {
    target_rig: rig,
    fingerprint: rigType === 'R6' ? '00000006' : rigType === 'R15' ? '00000015' : '00000001',
    rig_type: rigType,
    controller_class: rigType === 'custom' ? 'AnimationController' : 'Humanoid',
    controller_path: `${rig}.${rigType === 'custom' ? 'AnimationController' : 'Humanoid'}`,
    roots: [animatedParts[0]!.path],
    animated_parts: animatedParts,
    joints: animatedParts.slice(1).map((part, index) => ({
      name: part.via_joint_name!,
      class_name: part.via_joint_class!,
      path: part.via_joint_path!,
      relative_path: `${part.relative_path}.${part.via_joint_name}`,
      part0_path: animatedParts[index]!.path,
      part1_path: part.path,
      animated_part_path: part.path,
      animatable: true,
    })),
  };
}

const r6 = manifest('R6', [
  { name: 'HumanoidRootPart' },
  { name: 'Torso', parent: 'HumanoidRootPart', joint: 'RootJoint' },
  { name: 'Right Arm', parent: 'Torso', joint: 'Right Shoulder' },
]);

const r15 = manifest('R15', [
  { name: 'HumanoidRootPart' },
  { name: 'LowerTorso', parent: 'HumanoidRootPart', joint: 'Root' },
  { name: 'UpperTorso', parent: 'LowerTorso', joint: 'Waist' },
  { name: 'RightUpperArm', parent: 'UpperTorso', joint: 'RightShoulder' },
  { name: 'RightLowerArm', parent: 'RightUpperArm', joint: 'RightElbow' },
  { name: 'RightHand', parent: 'RightLowerArm', joint: 'RightWrist' },
]);

describe('animation definition', () => {
  it('infers duration and counts native authored data', () => {
    expect(validateAnimationDefinition(animation())).toEqual({ duration: 0.4, keyframes: 2, poseCount: 2, markerCount: 1 });
  });

  it('rejects non-increasing keyframes and too-short duration', () => {
    expect(() => validateAnimationDefinition(animation('A', { keyframes: [
      { time: 0.2, poses: [{ joint: 'A' }] }, { time: 0.2, poses: [{ joint: 'B' }] },
    ] }))).toThrow(/strictly increasing/);
    expect(() => validateAnimationDefinition(animation('RightShoulder', { duration: 0.1 }))).toThrow(/shorter/);
  });

  it('derives R6 targets from the supplied R6 manifest', () => {
    const resolved = resolveAnimationTargets(animation('Right Shoulder'), r6);
    expect(resolved.definition.target_rig).toBe('game.Workspace.R6Rig');
    expect(resolved.definition.keyframes[0]!.poses[0]!.joint).toBe('game.Workspace.R6Rig.RightArm');
  });

  it('derives the natural R15 arm chain from the supplied R15 manifest', () => {
    const definition = animation('RightUpperArm', { keyframes: [
      { time: 0, poses: [{ joint: 'UpperTorso' }, { joint: 'RightUpperArm' }, { joint: 'RightElbow' }, { joint: 'RightHand' }] },
      { time: 0.5, poses: [{ joint: 'UpperTorso' }, { joint: 'RightUpperArm' }, { joint: 'RightElbow' }, { joint: 'RightHand' }] },
    ] });
    const resolved = resolveAnimationTargets(definition, r15);
    expect(resolved.definition.keyframes[0]!.poses.map((pose) => pose.joint)).toEqual([
      'game.Workspace.R15Rig.UpperTorso',
      'game.Workspace.R15Rig.RightUpperArm',
      'game.Workspace.R15Rig.RightLowerArm',
      'game.Workspace.R15Rig.RightHand',
    ]);
  });

  it('supports custom Motor6D names and canonical paths without humanoid assumptions', () => {
    const custom = manifest('custom', [
      { name: 'Core' },
      { name: 'Turret', parent: 'Core', joint: 'YawMotor' },
      { name: 'Barrel', parent: 'Turret', joint: 'PitchMotor' },
    ]);
    const resolved = resolveAnimationTargets(animation('PitchMotor'), custom);
    expect(resolved.definition.keyframes[0]!.poses[0]!.joint).toBe('game.Workspace.customRig.Barrel');
    expect(custom.animated_parts.map((part) => part.name)).toEqual(['Core', 'Turret', 'Barrel']);
  });

  it('rejects unknown rig targets instead of inventing or substituting a rig', () => {
    expect(() => resolveAnimationTargets(animation('Right Shoulder'), r15)).toThrow(/authoritative rig/);
  });

  it('compiles dynamic Roblox-native inspection and an artifact with no registration side effect', () => {
    const inspection = compileRigInspection('game.Workspace.R15Rig');
    const custom = manifest('custom', [
      { name: 'Core' },
      { name: 'Emitter', parent: 'Core', joint: 'LaserGimbal' },
    ]);
    const source = compileAnimation(animation('game.Workspace.customRig.Emitter', {
      target_rig: 'game.Workspace.customRig',
    }), 0.4, custom);
    expect(inspection).toContain('descendant:IsA("Motor6D")');
    expect(inspection).toContain('AnimationConstraint');
    expect(source).toContain('Instance.new("KeyframeSequence")');
    expect(source).toContain('Instance.new("KeyframeMarker")');
    expect(source).not.toContain('RegisterActiveAnimationClip');
    expect(source).not.toContain('RegisterKeyframeSequence');
    expect(source).toContain('expected_fingerprint');
    expect(source).toContain('RIG_MANIFEST_STALE');
    expect(source).toContain('deployment_ready = false');
    expect(source).toContain('preview_id_scope = "none"');
    expect(source).toContain('artifact_committed = true');
    expect(source).not.toContain('rig_manifest =');
    expect(source).not.toContain('TweenService');
    for (const hardcoded of ['Right Arm', 'RightShoulder', 'UpperTorso', 'LowerTorso', 'RightUpperArm']) {
      expect(source).not.toContain(hardcoded);
    }
  });

  it('compiles marked native fixtures and guarded deterministic cleanup', () => {
    const acquire = compileAcquireRigFixture({ rig_type: 'R15', name: '__Fixture', position: [0, 3, 0] });
    const acquireR6 = compileAcquireRigFixture({ rig_type: 'R6', name: '__R6Fixture', position: [0, 3, 0] });
    const cleanup = compileCleanupRigFixture('game.Workspace.__Fixture', ['Wave']);
    expect(acquire).toContain('CreateHumanoidModelFromDescriptionAsync');
    expect(acquire).toContain('RobloxAgentManagedFixture');
    expect(acquire).toContain('discoverRig(rig)');
    expect(acquireR6).toContain('Enum.HumanoidRigType.R6');
    expect(cleanup).toContain('refusing to delete a rig that is not marked RobloxAgentManagedFixture');
    expect(cleanup).toContain('RobloxAgentArtifacts');
  });

  it('resolves and chronologically captures bounded preview times and markers', async () => {
    const definition = animation('RightShoulder');
    const samples = resolvePreviewSamples([{ time: 0.3 }, { marker: 'Release' }, { time: 0.1 }], definition, 0.4);
    expect(samples).toEqual([{ time: 0.1 }, { time: 0.3 }, { time: 0.4, marker: 'Release' }]);
    const delays: number[] = [];
    const captures: number[] = [];
    let clock = 0;
    let cleaned = 0;
    const result = await schedulePreviewCaptures(samples, async (sample) => {
      captures.push(clock); clock += 30; return `frame-${sample.time}`;
    }, async (milliseconds) => { delays.push(milliseconds); clock += milliseconds; }, async () => { cleaned += 1; }, false, () => clock);
    expect(result).toEqual(['frame-0.1', 'frame-0.3', 'frame-0.4']);
    expect(delays.map(Math.round)).toEqual([100, 170, 70]);
    expect(captures.map(Math.round)).toEqual([100, 300, 400]);
    expect(cleaned).toBe(1);
  });

  it('validates preview bounds/markers and cleans up when capture fails', async () => {
    const definition = animation('RightShoulder');
    expect(() => resolvePreviewSamples([{ time: 0.5 }], definition, 0.4)).toThrow(/outside clip duration/);
    expect(() => resolvePreviewSamples([{ marker: 'Missing' }], definition, 0.4)).toThrow(/resolve exactly once/);
    let cleaned = false;
    await expect(schedulePreviewCaptures([{ time: 0 }], async () => { throw new Error('capture failed'); }, async () => {}, async () => { cleaned = true; }, false))
      .rejects.toThrow('capture failed');
    expect(cleaned).toBe(true);
  });

  it('uses the live-verified non-active edit registration and runtime-only playback', () => {
    const registration = compileRegisterAnimationArtifact('game.ServerStorage.RobloxAgentArtifacts.Animations.Wave');
    const start = compileStartPlaytestPreview('game.Workspace.Rig', 'active://wave');
    expect(registration).toContain('AnimationClipProvider"):RegisterAnimationClip');
    expect(registration).not.toContain('RegisterActiveAnimationClip');
    expect(start).toContain('animator:LoadAnimation(animation)');
    expect(start).not.toContain('RegisterKeyframeSequence');
    expect(`${registration}${start}`).not.toContain('Instance.new("Script")');
  });
});
