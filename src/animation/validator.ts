import type { AnimationDefinition } from '../tools/schemas.js';

export interface AnimationValidation {
  duration: number;
  keyframes: number;
  poseCount: number;
  markerCount: number;
}

export function validateAnimationDefinition(definition: AnimationDefinition): AnimationValidation {
  let previous = -1;
  let poseCount = 0;
  let markerCount = 0;
  for (let index = 0; index < definition.keyframes.length; index += 1) {
    const keyframe = definition.keyframes[index]!;
    if (keyframe.time <= previous) {
      throw new Error(`keyframe times must be strictly increasing; index ${index} has ${keyframe.time} after ${previous}`);
    }
    previous = keyframe.time;
    const joints = new Set<string>();
    for (const pose of keyframe.poses) {
      if (joints.has(pose.joint)) throw new Error(`keyframe ${index} contains duplicate joint ${pose.joint}`);
      joints.add(pose.joint);
      poseCount += 1;
    }
    const markerNames = new Set<string>();
    for (const marker of keyframe.markers) {
      if (markerNames.has(marker.name)) throw new Error(`keyframe ${index} contains duplicate marker ${marker.name}`);
      markerNames.add(marker.name);
      markerCount += 1;
    }
  }
  const inferred = definition.keyframes.at(-1)!.time;
  const duration = definition.duration ?? inferred;
  if (duration < inferred) throw new Error(`duration ${duration} is shorter than final keyframe time ${inferred}`);
  if (duration <= 0) throw new Error('animation duration must be positive');
  return { duration, keyframes: definition.keyframes.length, poseCount, markerCount };
}

