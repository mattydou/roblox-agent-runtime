import type { AnimationDefinition } from '../tools/schemas.js';
import type { RigManifest } from './rig.js';
import { payloadExpression } from '../runtime/luau.js';

const PATH_HELPERS = String.raw`
local HttpService = game:GetService("HttpService")

local function child(parent, name)
  if parent == game then
    local ok, service = pcall(function() return game:GetService(name) end)
    if ok and service then return service end
  end
  return parent:FindFirstChild(name)
end

local function resolvePath(path)
  local cursor
  local index
  if path == "game" then return game end
  if path == "workspace" then return workspace end
  if string.sub(path, 1, 4) == "game" then cursor = game; index = 5
  elseif string.sub(path, 1, 9) == "workspace" then cursor = workspace; index = 10
  else error("path must start with game or workspace: " .. path) end
  while index <= #path do
    local marker = string.sub(path, index, index)
    local name
    if marker == "." then
      local start = index + 1
      local finish = start
      while finish <= #path and string.match(string.sub(path, finish, finish), "[A-Za-z0-9_]") do finish = finish + 1 end
      if finish == start then error("invalid dotted path segment in " .. path) end
      name = string.sub(path, start, finish - 1)
      index = finish
    elseif marker == "[" then
      if string.sub(path, index + 1, index + 1) ~= "\"" then error("bracket paths must use JSON double quotes in " .. path) end
      local quoteEnd
      local escaped = false
      for scan = index + 2, #path do
        local character = string.sub(path, scan, scan)
        if escaped then escaped = false
        elseif character == "\\" then escaped = true
        elseif character == "\"" then quoteEnd = scan; break end
      end
      if not quoteEnd or string.sub(path, quoteEnd + 1, quoteEnd + 1) ~= "]" then error("unterminated bracket path in " .. path) end
      local ok, decoded = pcall(function() return HttpService:JSONDecode(string.sub(path, index + 1, quoteEnd)) end)
      if not ok or type(decoded) ~= "string" then error("invalid bracket path segment in " .. path) end
      name = decoded
      index = quoteEnd + 2
    elseif marker == "/" then
      local closing = string.find(path, "/", index + 1, true) or (#path + 1)
      name = string.sub(path, index + 1, closing - 1)
      index = closing
    else error("invalid path syntax in " .. path) end
    cursor = child(cursor, name)
    if not cursor then error("instance not found: " .. path .. " (missing " .. name .. ")") end
  end
  return cursor
end

local function pathSegment(name)
  if string.match(name, "^[A-Za-z_][A-Za-z0-9_]*$") then return "." .. name end
  return "[" .. HttpService:JSONEncode(name) .. "]"
end

local function instancePath(instance)
  local segments = {}
  local cursor = instance
  while cursor and cursor ~= game do table.insert(segments, 1, pathSegment(cursor.Name)); cursor = cursor.Parent end
  return "game" .. table.concat(segments, "")
end

local function relativePath(instance, ancestor)
  local segments = {}
  local cursor = instance
  while cursor and cursor ~= ancestor do
    table.insert(segments, 1, cursor.Name)
    cursor = cursor.Parent
  end
  if cursor ~= ancestor then error(instancePath(instance) .. " is not inside " .. instancePath(ancestor)) end
  return table.concat(segments, ".")
end
`;

const RIG_FINGERPRINT = String.raw`
local function rigFingerprint(rig)
  if not rig or not rig:IsA("Model") then error("RIG_MANIFEST_STALE: target rig is missing or is no longer a Model") end
  local entries = {}
  for _, descendant in ipairs(rig:GetDescendants()) do
    local isAnimationLink = descendant:IsA("Motor6D") or descendant.ClassName == "AnimationConstraint"
    if isAnimationLink then
      local readable, part0, part1 = pcall(function() return descendant.Part0, descendant.Part1 end)
      if readable and part0 and part1 and part0:IsA("BasePart") and part1:IsA("BasePart")
        and part0:IsDescendantOf(rig) and part1:IsDescendantOf(rig) then
        table.insert(entries, table.concat({ descendant.ClassName, instancePath(descendant), instancePath(part0), instancePath(part1) }, "|"))
      end
    end
  end
  table.sort(entries)
  local controller = rig:FindFirstChildWhichIsA("Humanoid", true) or rig:FindFirstChildWhichIsA("AnimationController", true)
  table.insert(entries, 1, "controller|" .. (controller and controller.ClassName or "none") .. "|" .. (controller and instancePath(controller) or "none"))
  local encoded = table.concat(entries, "\n")
  local hash = 5381
  for index = 1, #encoded do hash = (hash * 33 + string.byte(encoded, index)) % 4294967296 end
  return string.format("%08x", hash), #entries - 1
end
`;

const RIG_DISCOVERY = String.raw`
local function discoverRig(rig)
  if not rig:IsA("Model") then error("target_rig must resolve to a Model") end

  local links = {}
  local parts = {}
  local adjacency = {}
  local incoming = {}
  local function addPart(part)
    parts[part] = true
    adjacency[part] = adjacency[part] or {}
  end
  for _, descendant in ipairs(rig:GetDescendants()) do
    local isAnimationLink = descendant:IsA("Motor6D") or descendant.ClassName == "AnimationConstraint"
    if isAnimationLink then
      local readable, part0, part1 = pcall(function() return descendant.Part0, descendant.Part1 end)
      if readable and part0 and part1 and part0:IsA("BasePart") and part1:IsA("BasePart")
        and part0:IsDescendantOf(rig) and part1:IsDescendantOf(rig) then
        table.insert(links, { instance = descendant, part0 = part0, part1 = part1 })
        addPart(part0)
        addPart(part1)
        table.insert(adjacency[part0], { link = descendant, other = part1 })
        table.insert(adjacency[part1], { link = descendant, other = part0 })
        incoming[part1] = (incoming[part1] or 0) + 1
      end
    end
  end
  if #links == 0 then error("authoritative target rig has no usable Motor6D or AnimationConstraint joints") end

  table.sort(links, function(left, right) return instancePath(left.instance) < instancePath(right.instance) end)
  local allParts = {}
  for part in pairs(parts) do table.insert(allParts, part) end
  table.sort(allParts, function(left, right) return instancePath(left) < instancePath(right) end)
  for _, part in ipairs(allParts) do
    table.sort(adjacency[part], function(left, right) return instancePath(left.link) < instancePath(right.link) end)
  end

  local controller = rig:FindFirstChildWhichIsA("Humanoid", true) or rig:FindFirstChildWhichIsA("AnimationController", true)
  local rigType = "custom"
  if controller and controller:IsA("Humanoid") then
    local ok, value = pcall(function() return controller.RigType.Name end)
    if ok and value then rigType = value end
  end

  local rootCandidates = {}
  local rootCandidateSet = {}
  local function addRootCandidate(part)
    if part and parts[part] and not rootCandidateSet[part] then
      rootCandidateSet[part] = true
      table.insert(rootCandidates, part)
    end
  end
  if controller and controller:IsA("Humanoid") then
    local ok, rootPart = pcall(function() return controller.RootPart end)
    if ok then addRootCandidate(rootPart) end
  end
  if rig.PrimaryPart then
    local ok, assemblyRoot = pcall(function() return rig.PrimaryPart:GetRootPart() end)
    if ok then addRootCandidate(assemblyRoot) end
    addRootCandidate(rig.PrimaryPart)
  end
  for _, part in ipairs(allParts) do
    if not incoming[part] then addRootCandidate(part) end
  end

  local visited = {}
  local nodes = {}
  local nodeByPart = {}
  local parentByPart = {}
  local roots = {}
  local function walk(rootPart)
    if visited[rootPart] then return end
    table.insert(roots, rootPart)
    visited[rootPart] = true
    local rootNode = { part = rootPart, depth = 0 }
    nodeByPart[rootPart] = rootNode
    table.insert(nodes, rootNode)
    local queue = { rootPart }
    local cursor = 1
    while cursor <= #queue do
      local parentPart = queue[cursor]
      cursor = cursor + 1
      local parentNode = nodeByPart[parentPart]
      for _, edge in ipairs(adjacency[parentPart]) do
        local connectedPart = edge.other
        if not visited[connectedPart] then
          visited[connectedPart] = true
          parentByPart[connectedPart] = parentPart
          local node = { part = connectedPart, parent = parentPart, via = edge.link, depth = parentNode.depth + 1 }
          nodeByPart[connectedPart] = node
          table.insert(nodes, node)
          table.insert(queue, connectedPart)
        end
      end
    end
  end
  for _, rootPart in ipairs(rootCandidates) do walk(rootPart) end
  for _, part in ipairs(allParts) do walk(part) end

  table.sort(nodes, function(left, right)
    if left.depth ~= right.depth then return left.depth < right.depth end
    return instancePath(left.part) < instancePath(right.part)
  end)

  local aliases = {}
  local function addAlias(alias, part)
    if not alias or alias == "" then return end
    aliases[alias] = aliases[alias] or {}
    aliases[alias][part] = true
  end
  local animatedParts = {}
  for _, node in ipairs(nodes) do
    local part = node.part
    local partPath = instancePath(part)
    local partRelativePath = relativePath(part, rig)
    local partAliases = { part.Name, partRelativePath, partPath }
    if node.via then
      table.insert(partAliases, node.via.Name)
      table.insert(partAliases, relativePath(node.via, rig))
      table.insert(partAliases, instancePath(node.via))
    end
    local uniqueAliases = {}
    local seenAliases = {}
    for _, alias in ipairs(partAliases) do
      if not seenAliases[alias] then
        seenAliases[alias] = true
        table.insert(uniqueAliases, alias)
        addAlias(alias, part)
      end
    end
    local record = {
      name = part.Name,
      path = partPath,
      relative_path = partRelativePath,
      depth = node.depth,
      aliases = uniqueAliases,
    }
    if node.parent then record.parent_path = instancePath(node.parent) end
    if node.via then
      record.via_joint_name = node.via.Name
      record.via_joint_path = instancePath(node.via)
      record.via_joint_class = node.via.ClassName
    end
    table.insert(animatedParts, record)
  end

  local joints = {}
  for _, linkRecord in ipairs(links) do
    local link = linkRecord.instance
    local animatedPart
    local node0 = nodeByPart[linkRecord.part0]
    local node1 = nodeByPart[linkRecord.part1]
    if node0 and node0.via == link then animatedPart = linkRecord.part0 end
    if node1 and node1.via == link then animatedPart = linkRecord.part1 end
    table.insert(joints, {
      name = link.Name,
      class_name = link.ClassName,
      path = instancePath(link),
      relative_path = relativePath(link, rig),
      part0_path = instancePath(linkRecord.part0),
      part1_path = instancePath(linkRecord.part1),
      animated_part_path = animatedPart and instancePath(animatedPart) or nil,
      animatable = animatedPart ~= nil,
    })
  end

  local rootPaths = {}
  for _, rootPart in ipairs(roots) do table.insert(rootPaths, instancePath(rootPart)) end
  local manifest = {
    target_rig = instancePath(rig),
    fingerprint = rigFingerprint(rig),
    rig_type = rigType,
    controller_class = controller and controller.ClassName or nil,
    controller_path = controller and instancePath(controller) or nil,
    roots = rootPaths,
    animated_parts = animatedParts,
    joints = joints,
  }
  return {
    manifest = manifest,
    controller = controller,
    aliases = aliases,
    nodes = nodes,
    parentByPart = parentByPart,
  }
end
`;

export function compileRigInspection(targetRig: string): string {
  const payload = payloadExpression({ target_rig: targetRig });
  return `
${PATH_HELPERS}
${RIG_FINGERPRINT}
${RIG_DISCOVERY}
local request = ${payload}
local rig = resolvePath(request.target_rig)
local graph = discoverRig(rig)
return HttpService:JSONEncode(graph.manifest)
`;
}

export function compileAcquireRigFixture(fixture: { rig_type: 'R6' | 'R15'; name?: string; position: [number, number, number] }): string {
  const payload = payloadExpression(fixture);
  return `
${PATH_HELPERS}
${RIG_FINGERPRINT}
${RIG_DISCOVERY}
local request = ${payload}
local Players = game:GetService("Players")
local description = Instance.new("HumanoidDescription")
local rigType = request.rig_type == "R15" and Enum.HumanoidRigType.R15 or Enum.HumanoidRigType.R6
local ok, rigOrError = pcall(function() return Players:CreateHumanoidModelFromDescriptionAsync(description, rigType) end)
description:Destroy()
if not ok then error("native fixture creation failed: " .. tostring(rigOrError)) end
local rig = rigOrError
rig.Name = request.name or ("__RobloxAgent" .. request.rig_type .. "Fixture")
rig:SetAttribute("RobloxAgentManagedFixture", true)
rig:SetAttribute("RobloxAgentFixtureRigType", request.rig_type)
local existing = workspace:FindFirstChild(rig.Name)
if existing then rig:Destroy(); error("fixture name already exists: " .. rig.Name) end
rig:PivotTo(CFrame.new(request.position[1], request.position[2], request.position[3]))
rig.Parent = workspace
local graph = discoverRig(rig)
return HttpService:JSONEncode({ success = true, managed_fixture = true, target_rig = instancePath(rig), rig = graph.manifest })
`;
}

export function compileCleanupRigFixture(targetRig: string, artifactNames: string[]): string {
  const payload = payloadExpression({ target_rig: targetRig, artifact_names: artifactNames });
  return `
${PATH_HELPERS}
local request = ${payload}
local found, rig = pcall(function() return resolvePath(request.target_rig) end)
local deletedPath = nil
if found then
  if not rig:IsA("Model") or rig:GetAttribute("RobloxAgentManagedFixture") ~= true then
    error("refusing to delete a rig that is not marked RobloxAgentManagedFixture")
  end
  deletedPath = instancePath(rig)
  rig:Destroy()
end
local animations = game:GetService("ServerStorage"):FindFirstChild("RobloxAgentArtifacts")
animations = animations and animations:FindFirstChild("Animations")
local removedArtifacts = {}
if animations then
  for _, name in ipairs(request.artifact_names) do
    for _, candidate in ipairs({ name, name .. "_Preview" }) do
      local artifact = animations:FindFirstChild(candidate)
      if artifact then artifact:Destroy(); table.insert(removedArtifacts, candidate) end
    end
  end
end
return HttpService:JSONEncode({ success = true, managed_fixture = true, deleted = deletedPath, already_absent = not found, removed_artifacts = removedArtifacts })
`;
}

export function compileRegisterAnimationArtifact(artifactPath: string): string {
  const payload = payloadExpression({ artifact_path: artifactPath });
  return `
${PATH_HELPERS}
local request = ${payload}
local sequence = resolvePath(request.artifact_path)
if not sequence:IsA("KeyframeSequence") then error("artifact_path must resolve to a KeyframeSequence") end
local contentId = game:GetService("AnimationClipProvider"):RegisterAnimationClip(sequence)
return HttpService:JSONEncode({ success = true, registered = true, preview_id = contentId, context = "edit" })
`;
}

export function compileStartPlaytestPreview(targetRig: string, previewId: string, play = true): string {
  const payload = payloadExpression({ target_rig: targetRig, preview_id: previewId, play });
  return `
${PATH_HELPERS}
local request = ${payload}
local rig = resolvePath(request.target_rig)
if not rig:IsA("Model") then error("runtime target_rig must resolve to a Model") end
local controller = rig:FindFirstChildWhichIsA("Humanoid", true) or rig:FindFirstChildWhichIsA("AnimationController", true)
if not controller then error("runtime target rig has no animation controller") end
local animator = controller:FindFirstChildWhichIsA("Animator")
if not animator then animator = Instance.new("Animator"); animator.Parent = controller end
if not request.play then return HttpService:JSONEncode({ success = true, preview_id = request.preview_id, registered = true, played = false }) end
local animation = Instance.new("Animation")
animation.Name = "RobloxAgentManagedRuntimePreview"
animation.AnimationId = request.preview_id
animation:SetAttribute("RobloxAgentManagedRuntimePreview", true)
animation.Parent = rig
local loaded, trackOrError = pcall(function()
  local track = animator:LoadAnimation(animation)
  track:Play(0)
  return track
end)
if not loaded then animation:Destroy(); error(trackOrError) end
rig:SetAttribute("RobloxAgentManagedRuntimePreviewId", request.preview_id)
return HttpService:JSONEncode({ success = true, preview_id = request.preview_id, registered = true, played = true, track_starts = 1 })
`;
}

export function compileStopPlaytestPreview(targetRig: string, previewId: string): string {
  const payload = payloadExpression({ target_rig: targetRig, preview_id: previewId });
  return `
${PATH_HELPERS}
local request = ${payload}
local rig = resolvePath(request.target_rig)
local controller = rig:FindFirstChildWhichIsA("Humanoid", true) or rig:FindFirstChildWhichIsA("AnimationController", true)
local animator = controller and controller:FindFirstChildWhichIsA("Animator")
local stopped = 0
if animator then for _, track in ipairs(animator:GetPlayingAnimationTracks()) do
  if track.Animation and track.Animation.AnimationId == request.preview_id then track:Stop(0); stopped += 1 end
end end
for _, childInstance in ipairs(rig:GetChildren()) do
  if childInstance:IsA("Animation") and childInstance:GetAttribute("RobloxAgentManagedRuntimePreview") == true and childInstance.AnimationId == request.preview_id then childInstance:Destroy() end
end
rig:SetAttribute("RobloxAgentManagedRuntimePreviewId", nil)
return HttpService:JSONEncode({ success = true, stopped = stopped })
`;
}

export function compileAnimation(definition: AnimationDefinition, duration: number, manifest: RigManifest): string {
  const hierarchy = manifest.animated_parts.map((part) => ({
    path: part.path,
    ...(part.parent_path ? { parent_path: part.parent_path } : {}),
  }));
  const payload = payloadExpression({
    definition: { ...definition, duration },
    expected_fingerprint: manifest.fingerprint,
    hierarchy,
  });
  return `
${PATH_HELPERS}
${RIG_FINGERPRINT}
local request = ${payload}
local definition = request.definition
local rigOk, rigOrError = pcall(function() return resolvePath(definition.target_rig) end)
if not rigOk then error("RIG_MANIFEST_STALE: authoritative target rig disappeared: " .. tostring(rigOrError)) end
local rig = rigOrError
if not rig:IsA("Model") then error("RIG_MANIFEST_STALE: authoritative target rig is no longer a Model") end
local currentFingerprint = rigFingerprint(rig)
if currentFingerprint ~= request.expected_fingerprint then
  error("RIG_MANIFEST_STALE: authoritative target rig animation hierarchy changed")
end

local partByPath = {}
local parentByPart = {}
for _, node in ipairs(request.hierarchy) do
  local ok, part = pcall(function() return resolvePath(node.path) end)
  if not ok or not part:IsA("BasePart") or not part:IsDescendantOf(rig) then
    error("RIG_MANIFEST_STALE: cached animated part is missing: " .. node.path)
  end
  partByPath[node.path] = part
end
for _, node in ipairs(request.hierarchy) do
  if node.parent_path then
    local part = partByPath[node.path]
    local parentPart = partByPath[node.parent_path]
    if not parentPart then error("RIG_MANIFEST_STALE: cached parent part is missing: " .. node.parent_path) end
    parentByPart[part] = parentPart
  end
end

local resolvedParts = {}
for _, keyframeDefinition in ipairs(definition.keyframes) do
  for _, poseDefinition in ipairs(keyframeDefinition.poses) do
    local selected = partByPath[poseDefinition.joint]
    if not selected then error("RIG_MANIFEST_STALE: canonical animated part is missing: " .. poseDefinition.joint) end
    resolvedParts[poseDefinition.joint] = selected
  end
end

local serverStorage = game:GetService("ServerStorage")
local root = serverStorage:FindFirstChild("RobloxAgentArtifacts")
if not root then root = Instance.new("Folder"); root.Name = "RobloxAgentArtifacts"; root.Parent = serverStorage end
local animations = root:FindFirstChild("Animations")
if not animations then animations = Instance.new("Folder"); animations.Name = "Animations"; animations.Parent = root end

local existing = animations:FindFirstChild(definition.name)
if existing and not definition.replace_existing then error("animation artifact already exists: " .. instancePath(existing)) end

local sequence = Instance.new("KeyframeSequence")
sequence.Name = definition.name .. "__RobloxAgentPending"
sequence:SetAttribute("RobloxAgentPendingAnimationArtifact", true)
sequence.Loop = definition.loop
sequence.Priority = Enum.AnimationPriority[definition.priority]

local function buildKeyframe(keyframeDefinition)
  local keyframe = Instance.new("Keyframe")
  keyframe.Time = keyframeDefinition.time
  if keyframeDefinition.name then keyframe.Name = keyframeDefinition.name end
  local poseByPart = {}
  local specByPart = {}
  for _, poseDefinition in ipairs(keyframeDefinition.poses) do
    specByPart[resolvedParts[poseDefinition.joint]] = poseDefinition
  end
  local constructing = {}
  local function ensurePose(part)
    if poseByPart[part] then return poseByPart[part] end
    if constructing[part] then error("cycle in derived animation hierarchy at " .. instancePath(part)) end
    constructing[part] = true
    local pose = Instance.new("Pose")
    pose.Name = part.Name
    local spec = specByPart[part]
    if spec then
      local p = spec.position
      local r = spec.rotation_degrees
      pose.CFrame = CFrame.new(p[1], p[2], p[3]) * CFrame.fromOrientation(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
      pose.EasingStyle = Enum.PoseEasingStyle[spec.easing_style]
      pose.EasingDirection = Enum.PoseEasingDirection[spec.easing_direction]
    else
      pose.CFrame = CFrame.identity
      pose.EasingStyle = Enum.PoseEasingStyle.Linear
      pose.EasingDirection = Enum.PoseEasingDirection.InOut
    end
    poseByPart[part] = pose
    local parentPart = parentByPart[part]
    if parentPart then ensurePose(parentPart):AddSubPose(pose) else keyframe:AddPose(pose) end
    constructing[part] = nil
    return pose
  end
  for part in pairs(specByPart) do ensurePose(part) end
  for _, markerDefinition in ipairs(keyframeDefinition.markers or {}) do
    local marker = Instance.new("KeyframeMarker")
    marker.Name = markerDefinition.name
    marker.Value = markerDefinition.value
    keyframe:AddMarker(marker)
  end
  return keyframe
end

local ok, buildError = pcall(function()
  for _, keyframeDefinition in ipairs(definition.keyframes) do sequence:AddKeyframe(buildKeyframe(keyframeDefinition)) end
end)
if not ok then sequence:Destroy(); error(buildError) end
sequence.Name = definition.name
sequence:SetAttribute("RobloxAgentPendingAnimationArtifact", nil)
local committed, commitError = pcall(function() sequence.Parent = animations end)
if not committed then sequence:Destroy(); error("animation artifact commit failed: " .. tostring(commitError)) end
if existing then
  local replaced, replaceError = pcall(function() existing:Destroy() end)
  if not replaced then sequence:Destroy(); error("animation replacement commit failed; previous artifact preserved: " .. tostring(replaceError)) end
end
local legacyPreview = animations:FindFirstChild(definition.name .. "_Preview")
if legacyPreview then pcall(function() legacyPreview:Destroy() end) end
return HttpService:JSONEncode({
  success = true,
  kind = "animation",
  artifact_path = instancePath(sequence),
  artifact_committed = true,
  preview_id_scope = "none",
  deployment_ready = false,
  preview_registered = false,
  preview_play = { requested = false, success = nil },
  stages = {
    validation = { success = true },
    artifact = { success = true, committed = true, path = instancePath(sequence) },
    registration = { requested = false, success = nil },
    playback = { requested = false, success = nil },
    observation = { requested = false, success = nil },
  },
  target_rig = instancePath(rig),
  rig = {
    rig_type = ${payloadExpression(manifest.rig_type)},
    fingerprint = currentFingerprint,
  },
  duration = definition.duration,
  keyframes = #definition.keyframes,
  joints = (function() local count = 0; for _ in pairs(resolvedParts) do count = count + 1 end; return count end)(),
})
`;
}
