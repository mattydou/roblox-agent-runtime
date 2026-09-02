import { payloadExpression, RUNTIME_PATH_HELPERS, RUNTIME_SERIALIZER } from './luau.js';

export type EvidenceHarnessOperation = 'begin' | 'health' | 'snapshot' | 'install' | 'probe' | 'collect' | 'reset' | 'wait_for' | 'tool' | 'position' | 'interaction' | 'cleanup';

/** Fixed runtime-owned evidence harness. Request data is JSON and never executable source. */
export function compileEvidenceHarness(request: Record<string, unknown> & { operation: EvidenceHarnessOperation }): string {
  const payload = payloadExpression(request);
  return `
${RUNTIME_PATH_HELPERS}
${RUNTIME_SERIALIZER}
local request = ${payload}
local registry = _G.__ROBLOX_AGENT_EVIDENCE_V2
if type(registry) ~= "table" then registry = {}; _G.__ROBLOX_AGENT_EVIDENCE_V2 = registry end
local MAX_EVENTS = 50
local MAX_SAMPLES = 100
local function now(state) return math.max(0, os.clock() - state.started_at) end
local function markerName(role) return "__RobloxAgentEvidence_" .. string.gsub(role, "[^A-Za-z0-9_]", "_") end
local function disconnectState(state)
  state.cancelled = true
  for _, watch in pairs(state.watches or {}) do
    if watch.connection then watch.connection:Disconnect(); watch.connection = nil end
    if watch.connection2 then watch.connection2:Disconnect(); watch.connection2 = nil end
  end
  for _, series in pairs(state.series or {}) do series.cancelled = true end
end
local function resetCurrent(state)
  disconnectState(state)
  state.watches = {}
  state.series = {}
  state.cancelled = false
end
local function requireState()
  local state = registry[request.session_id]
  if not state or state.role ~= request.role then error("EVIDENCE_SESSION_HARNESS_MISSING") end
  return state
end
local function matches(instance, spec)
  if spec.name and instance.Name ~= spec.name then return false end
  if spec.class_name and instance.ClassName ~= spec.class_name then return false end
  return true
end
local function appendBounded(list, value, owner)
  if #list < MAX_EVENTS then table.insert(list, value) else owner.dropped = (owner.dropped or 0) + 1 end
end
local function evaluateProbe(state, probe)
  if probe.kind == "exists" then
    local ok, instance = pcall(function() return resolvePath(probe.path) end)
    local result = { id = probe.id, kind = probe.kind, context = request.role, path = probe.path, exists = ok and instance ~= nil, status = ok and "ok" or "absent" }
    if not ok then result.error = string.sub(tostring(instance), 1, 300) end
    return result
  end
  local target = resolvePath(probe.path)
  if probe.kind == "property" then
    local ok, value = pcall(function() return target[probe.property] end)
    if not ok then return { id = probe.id, kind = probe.kind, context = request.role, path = probe.path, property = probe.property, status = "unsupported", error = string.sub(tostring(value), 1, 500) } end
    return { id = probe.id, kind = probe.kind, context = request.role, path = pathOf(target), property = probe.property, status = "ok", value = serializeValue(value) }
  end
  if probe.kind == "descendant_count" then
    local count = 0
    for _, descendant in ipairs(target:GetDescendants()) do if matches(descendant, probe) then count += 1 end end
    return { id = probe.id, kind = probe.kind, context = request.role, path = pathOf(target), count = count, name = probe.name, class_name = probe.class_name }
  end
  error("unsupported probe kind")
end

local Players = game:GetService("Players")
local function resolvePlayer(name)
  if name then local player = Players:FindFirstChild(name); if player and player:IsA("Player") then return player end return nil end
  if Players.LocalPlayer then return Players.LocalPlayer end
  local available = Players:GetPlayers(); table.sort(available, function(a, b) return a.Name < b.Name end); return available[1]
end
local function vector(value) return value and { value.X, value.Y, value.Z } or nil end
local function playerSnapshot(name)
  local player = resolvePlayer(name)
  if not player then return { player_available = false } end
  local character = player.Character
  local humanoid = character and character:FindFirstChildWhichIsA("Humanoid")
  local root = character and (character:FindFirstChild("HumanoidRootPart") or character.PrimaryPart or character:FindFirstChildWhichIsA("BasePart"))
  local backpack = player:FindFirstChildOfClass("Backpack")
  local tools, equipped = {}, {}
  if backpack then for _, child in ipairs(backpack:GetChildren()) do if child:IsA("Tool") and #tools < 20 then table.insert(tools, pathOf(child)) end end end
  if character then for _, child in ipairs(character:GetChildren()) do if child:IsA("Tool") and #equipped < 20 then table.insert(equipped, pathOf(child)) end end end
  table.sort(tools); table.sort(equipped)
  local pivot
  if character then local ok, value = pcall(function() return character:GetPivot().Position end); if ok then pivot = value end end
  return {
    player_available = true, player_name = player.Name, user_id = player.UserId,
    character_available = character ~= nil, character_path = character and pathOf(character) or nil, character_position = vector(pivot),
    humanoid_available = humanoid ~= nil, health = humanoid and humanoid.Health or nil, max_health = humanoid and humanoid.MaxHealth or nil,
    root_available = root ~= nil, root_path = root and pathOf(root) or nil, root_position = root and vector(root.Position) or nil,
    backpack_available = backpack ~= nil, backpack_path = backpack and pathOf(backpack) or nil,
    tools = tools, equipped_tools = equipped, tool_count = #tools, equipped_count = #equipped,
  }
end
local function waitUntil(timeoutMs, pollMs, callback)
  local started, last = os.clock(), nil
  repeat
    local ok, success, value = pcall(callback)
    if ok then last = value; if success then return true, value, (os.clock() - started) * 1000 end else last = { error = string.sub(tostring(success), 1, 500) } end
    if (os.clock() - started) * 1000 >= timeoutMs then break end
    task.wait(math.min(pollMs, math.max(1, timeoutMs - (os.clock() - started) * 1000)) / 1000)
  until false
  return false, last, (os.clock() - started) * 1000
end
local function exactTool(player, target)
  if not player then return nil end
  if target and (string.sub(target, 1, 4) == "game" or string.sub(target, 1, 9) == "workspace") then
    local ok, found = pcall(function() return resolvePath(target) end); if ok then return found end; return nil
  end
  local character, backpack = player.Character, player:FindFirstChildOfClass("Backpack")
  return (character and character:FindFirstChild(target)) or (backpack and backpack:FindFirstChild(target))
end
local function effectiveGui(instance)
  local cursor, visible, interactable = instance, true, true
  while cursor and cursor ~= game do
    if cursor:IsA("GuiObject") then if not cursor.Visible then visible = false end; local ok, value = pcall(function() return cursor.Interactable end); if ok and value == false then interactable = false end end
    if cursor:IsA("LayerCollector") then local ok, value = pcall(function() return cursor.Enabled end); if ok and value == false then visible = false end end
    cursor = cursor.Parent
  end
  return visible, interactable
end
local function readiness(spec)
  if spec.condition == "path_exists" then local ok, value = pcall(function() return resolvePath(spec.path) end); return ok, { path = spec.path, exists = ok, class_name = ok and value.ClassName or nil } end
  local player = resolvePlayer(spec.player)
  local state = playerSnapshot(spec.player)
  if spec.condition == "player_available" then return player ~= nil, state end
  local character = player and player.Character
  if spec.condition == "character_available" then return character ~= nil, state end
  local humanoid = character and character:FindFirstChildWhichIsA("Humanoid")
  local root = character and (character:FindFirstChild("HumanoidRootPart") or character.PrimaryPart)
  if spec.condition == "character_ready" then return humanoid ~= nil and root ~= nil, state end
  local backpack = player and player:FindFirstChildOfClass("Backpack")
  if spec.condition == "backpack_available" then return backpack ~= nil, state end
  if spec.condition == "tool_available" or spec.condition == "tool_equipped" then
    local tool = exactTool(player, spec.tool); state.requested_tool = spec.tool; state.resolved_tool = tool and pathOf(tool) or nil
    local available = tool and tool:IsA("Tool") and (spec.condition ~= "tool_equipped" or tool.Parent == character)
    return available == true, state
  end
  local ok, target = pcall(function() return resolvePath(spec.path) end)
  if not ok then return false, { path = spec.path, exists = false } end
  if spec.condition == "gui_available" then local visible, interactable = effectiveGui(target); return target:IsA("GuiObject") and visible and interactable, { path = pathOf(target), class_name = target.ClassName, visible = visible, interactable = interactable } end
  if spec.condition == "interaction_available" then
    local expected = spec.interaction == "proximity_prompt" and "ProximityPrompt" or spec.interaction == "click_detector" and "ClickDetector" or "GuiButton"
    local classOk = expected == "GuiButton" and (target:IsA("TextButton") or target:IsA("ImageButton")) or target.ClassName == expected
    return classOk, { path = pathOf(target), class_name = target.ClassName, expected_class = expected }
  end
  return false, { unsupported_condition = spec.condition }
end

if request.operation == "begin" then
  local container = game:GetService("ReplicatedStorage")
  local name = markerName(request.role)
  local prior = container:FindFirstChild(name)
  if prior then
    if prior:GetAttribute("RobloxAgentManagedEvidence") ~= true then error("UNMARKED_EVIDENCE_HARNESS_CONFLICT") end
    local priorSession = prior:GetAttribute("RobloxAgentEvidenceSessionId")
    if priorSession ~= request.session_id then
      local stale = registry[priorSession]
      if stale then disconnectState(stale); registry[priorSession] = nil end
      prior:Destroy()
      prior = nil
    elseif registry[priorSession] then
      disconnectState(registry[priorSession])
    end
  end
  if not prior then
    prior = Instance.new("Folder")
    prior.Name = name
    prior:SetAttribute("RobloxAgentManagedEvidence", true)
    prior:SetAttribute("RobloxAgentEvidenceSessionId", request.session_id)
    prior.Parent = container
  end
  registry[request.session_id] = { role = request.role, revision = request.revision, started_at = os.clock(), watches = {}, series = {}, marker = prior, cancelled = false }
  return HttpService:JSONEncode({ success = true, session_id = request.session_id, role = request.role, revision = request.revision, stale_harness_removed = request.stale_harness_removed == true })
end

local state = requireState()
if request.operation == "health" then
  return HttpService:JSONEncode({ success = true, role = request.role, harness = "healthy", session_id = request.session_id })
end
if request.operation == "snapshot" then
  return HttpService:JSONEncode({ success = true, role = request.role, state = playerSnapshot(request.player) })
end
if request.operation == "wait_for" then
  local ok, observed, elapsed = waitUntil(request.timeout_ms, request.poll_interval_ms, function() return readiness(request) end)
  return HttpService:JSONEncode({ success = ok, condition = request.condition, elapsed_ms = elapsed, last_successful_checkpoint = ok and request.condition or "harness healthy", observed = observed, error_code = ok and nil or "READINESS_TIMEOUT" })
end
if request.operation == "install" then
  state.cancelled = false
  for _, spec in ipairs(request.watches or {}) do
    if state.watches[spec.id] then error("duplicate watch id: " .. spec.id) end
    local target = resolvePath(spec.path)
    local watch = { id = spec.id, kind = spec.kind, context = request.role, path = pathOf(target), property = spec.property, events = {}, dropped = 0, count = 0 }
    if spec.kind == "instance_lifecycle" then
      watch.added_count, watch.removed_count = 0, 0
      watch.known_paths = {}
      watch.connection = target.DescendantAdded:Connect(function(instance)
        if matches(instance, spec) then
          watch.added_count += 1
          local canonical = pathOf(instance)
          watch.known_paths[instance] = canonical
          appendBounded(watch.events, { event = "added", time = now(state), path = canonical, class_name = instance.ClassName }, watch)
        end
      end)
      watch.connection2 = target.DescendantRemoving:Connect(function(instance)
        if matches(instance, spec) then
          watch.removed_count += 1
          appendBounded(watch.events, { event = "removed", time = now(state), path = watch.known_paths[instance] or pathOf(instance), class_name = instance.ClassName }, watch)
          watch.known_paths[instance] = nil
        end
      end)
    elseif spec.kind == "signal" then
      local ok, signal = pcall(function() return target[spec.signal] end)
      if not ok or typeof(signal) ~= "RBXScriptSignal" then error("requested member is not an RBXScriptSignal: " .. spec.signal) end
      watch.connection = signal:Connect(function()
        watch.count += 1
        appendBounded(watch.events, { time = now(state) }, watch)
      end)
    elseif spec.kind == "property_change" then
      local readable, initial = pcall(function() return target[spec.property] end)
      if not readable then error("property is not readable: " .. spec.property) end
      watch.initial_value, watch.final_value = serializeValue(initial), serializeValue(initial)
      local connected, connection = pcall(function()
        return target:GetPropertyChangedSignal(spec.property):Connect(function()
          local ok, value = pcall(function() return target[spec.property] end)
          watch.count += 1
          watch.final_value = ok and serializeValue(value) or { type = "property_error" }
          appendBounded(watch.events, { time = now(state), value = watch.final_value }, watch)
        end)
      end)
      if not connected then error("property change signal unavailable: " .. string.sub(tostring(connection), 1, 300)) end
      watch.connection = connection
    else error("unsupported watch kind") end
    state.watches[spec.id] = watch
  end
  for _, spec in ipairs(request.series or {}) do
    if state.series[spec.id] then error("duplicate series id: " .. spec.id) end
    local series = { id = spec.id, context = request.role, requested_interval_ms = spec.interval_ms, requested_duration_ms = spec.duration_ms, samples = {}, dropped = 0, missed = 0, completed = false, cancelled = false }
    state.series[spec.id] = series
    task.spawn(function()
      local seriesStarted = os.clock()
      while not state.cancelled and not series.cancelled do
        local elapsedMs = (os.clock() - seriesStarted) * 1000
        if elapsedMs > spec.duration_ms then break end
        local ok, sample = pcall(function() return evaluateProbe(state, spec.probe) end)
        local value = ok and (sample.value ~= nil and sample.value or sample.count ~= nil and sample.count or sample.exists) or { type = "probe_error" }
        if #series.samples < MAX_SAMPLES then table.insert(series.samples, { time = now(state), value = value }) else series.dropped += 1 end
        local remainingMs = spec.duration_ms - (os.clock() - seriesStarted) * 1000
        if remainingMs <= 0 then break end
        task.wait(math.min(spec.interval_ms, remainingMs) / 1000)
      end
      series.actual_duration_ms = (os.clock() - seriesStarted) * 1000
      series.completed = not state.cancelled and not series.cancelled
      if #series.samples > 1 then
        series.actual_interval_ms = (series.samples[#series.samples].time - series.samples[1].time) * 1000 / (#series.samples - 1)
      end
      local expected = math.floor(spec.duration_ms / spec.interval_ms) + 1
      series.missed = math.max(0, expected - #series.samples - series.dropped)
    end)
  end
  return HttpService:JSONEncode({ success = true, installed_watches = #(request.watches or {}), installed_series = #(request.series or {}) })
end

if request.operation == "probe" then
  local results = {}
  for _, probe in ipairs(request.probes or {}) do table.insert(results, evaluateProbe(state, probe)) end
  return HttpService:JSONEncode({ success = true, probes = results })
end

if request.operation == "tool" then
  local ready, observed, elapsed = waitUntil(request.timeout_ms, request.poll_interval_ms, function()
    local player = resolvePlayer(request.player); local character = player and player.Character; local humanoid = character and character:FindFirstChildWhichIsA("Humanoid"); local backpack = player and player:FindFirstChildOfClass("Backpack"); local tool = exactTool(player, request.target)
    local prerequisites = player and character and humanoid and (request.tool_operation == "unequip" or backpack)
    local targetReady = request.tool_operation == "unequip" and (not request.target or tool ~= nil) or tool ~= nil
    return prerequisites and targetReady, { player = player, character = character, humanoid = humanoid, backpack = backpack, tool = tool, snapshot = playerSnapshot(request.player) }
  end)
  if not ready then
    local snapshot = observed and observed.snapshot or observed
    local prerequisitesReady = snapshot and snapshot.player_available and snapshot.character_available and snapshot.humanoid_available and (request.tool_operation == "unequip" or snapshot.backpack_available)
    return HttpService:JSONEncode({ success = false, error_code = prerequisitesReady and "TOOL_NOT_FOUND" or "TOOL_READINESS_TIMEOUT", elapsed_ms = elapsed, target = request.target, observed = snapshot })
  end
  local player, character, humanoid, tool = observed.player, observed.character, observed.humanoid, observed.tool
  if request.tool_operation == "unequip" then
    local selected = request.target and exactTool(player, request.target) or nil
    if selected and not selected:IsA("Tool") then return HttpService:JSONEncode({ success = false, error_code = "WRONG_CLASS", actual_class = selected.ClassName }) end
    humanoid:UnequipTools()
    local remaining = {}
    for _, child in ipairs(character:GetChildren()) do if child:IsA("Tool") then table.insert(remaining, pathOf(child)) end end
    local verified = request.target and (not selected or selected.Parent ~= character) or #remaining == 0
    if not verified then return HttpService:JSONEncode({ success = false, error_code = "TOOL_UNEQUIP_NOT_VERIFIED", tool_path = selected and pathOf(selected) or nil, remaining = remaining }) end
    return HttpService:JSONEncode({ success = true, operation = "unequip", verified_unequipped = true, tool_path = selected and pathOf(selected) or nil, remaining = remaining })
  end
  if not tool:IsA("Tool") then return HttpService:JSONEncode({ success = false, error_code = "WRONG_CLASS", actual_class = tool.ClassName }) end
  local autoEquipped = false
  if request.tool_operation == "equip" or (request.tool_operation == "activate" and request.auto_equip and tool.Parent ~= character) then humanoid:EquipTool(tool); autoEquipped = request.tool_operation == "activate" end
  if request.tool_operation == "equip" or autoEquipped then
    local equipped = waitUntil(request.timeout_ms, request.poll_interval_ms, function() return tool.Parent == character, { tool_path = pathOf(tool), parent_path = tool.Parent and pathOf(tool.Parent) or nil } end)
    if not equipped then return HttpService:JSONEncode({ success = false, error_code = "TOOL_EQUIP_NOT_VERIFIED", tool_path = pathOf(tool) }) end
  end
  if request.tool_operation == "activate" then
    if tool.Parent ~= character then return HttpService:JSONEncode({ success = false, error_code = "TOOL_NOT_EQUIPPED", tool_path = pathOf(tool) }) end
    tool:Activate()
  end
  return HttpService:JSONEncode({ success = true, operation = request.tool_operation, tool_path = pathOf(tool), equipped = tool.Parent == character, auto_equip = autoEquipped })
end

if request.operation == "position" then
  local function characterOf(spec) local player = resolvePlayer(spec.player); return player and player.Character or nil end
  local subject
  local ready, observed, elapsed = waitUntil(request.timeout_ms, 100, function()
    subject = request.subject.kind == "path" and resolvePath(request.subject.path) or characterOf(request.subject)
    local anchor = request.destination.kind == "path" and resolvePath(request.destination.path) or request.destination.kind == "character" and characterOf(request.destination) or nil
    return subject ~= nil and (request.destination.kind == "position" or anchor ~= nil), { subject = subject, anchor = anchor }
  end)
  if not ready then return HttpService:JSONEncode({ success = false, error_code = "POSITION_READINESS_TIMEOUT", elapsed_ms = elapsed, observed = playerSnapshot((request.destination.player or request.subject.player)) }) end
  subject, observed = observed.subject, observed
  if not (subject:IsA("Model") or subject:IsA("BasePart")) then return HttpService:JSONEncode({ success = false, error_code = "POSITION_SUBJECT_WRONG_CLASS", actual_class = subject.ClassName }) end
  local current = subject:IsA("Model") and subject:GetPivot() or subject.CFrame
  local anchorCF
  if request.destination.kind == "position" then anchorCF = CFrame.new(Vector3.new(request.destination.position[1], request.destination.position[2], request.destination.position[3]))
  else local anchor = observed.anchor; anchorCF = anchor:IsA("Model") and anchor:GetPivot() or anchor:IsA("BasePart") and anchor.CFrame or nil end
  if not anchorCF then return HttpService:JSONEncode({ success = false, error_code = "POSITION_ANCHOR_WRONG_CLASS" }) end
  local offset = Vector3.new(request.offset[1], request.offset[2], request.offset[3])
  local position = anchorCF.Position + (request.offset_space == "anchor" and anchorCF:VectorToWorldSpace(offset) or offset)
  local rotation = current.Rotation
  if request.orientation.kind == "yaw" then rotation = CFrame.Angles(0, math.rad(request.orientation.degrees), 0)
  elseif request.orientation.kind == "face_path" or request.orientation.kind == "face_position" then
    local face = request.orientation.kind == "face_position" and Vector3.new(request.orientation.position[1], request.orientation.position[2], request.orientation.position[3]) or (function() local target = resolvePath(request.orientation.path); return target:IsA("Model") and target:GetPivot().Position or target.Position end)()
    local flat = Vector3.new(face.X, position.Y, face.Z); if (flat - position).Magnitude > 0.001 then rotation = CFrame.lookAt(position, flat).Rotation end
  end
  local requestedCF = CFrame.new(position) * rotation
  if subject:IsA("Model") then subject:PivotTo(requestedCF) else subject.CFrame = requestedCF end
  local actual = subject:IsA("Model") and subject:GetPivot() or subject.CFrame
  local distance = (actual.Position - position).Magnitude
  return HttpService:JSONEncode({ success = distance <= request.tolerance, error_code = distance <= request.tolerance and nil or "POSITION_VERIFICATION_FAILED", subject_path = pathOf(subject), anchor_path = observed.anchor and pathOf(observed.anchor) or nil, requested_offset = request.offset, offset_space = request.offset_space, requested_position = vector(position), actual_position = vector(actual.Position), distance = distance, tolerance = request.tolerance, look_vector = vector(actual.LookVector) })
end

if request.operation == "interaction" then
  local resolved, target, resolveElapsed = waitUntil(request.timeout_ms, request.poll_interval_ms, function()
    local ok, value = pcall(function() return resolvePath(request.path) end); return ok, ok and value or { error = string.sub(tostring(value), 1, 300) }
  end)
  if not resolved then return HttpService:JSONEncode({ success = false, error_code = "INTERACTION_TARGET_NOT_FOUND", path = request.path, elapsed_ms = resolveElapsed, observed = target }) end
  local player = resolvePlayer(nil); local snapshot = playerSnapshot(nil)
  if request.interaction == "proximity_prompt" then
    if not target:IsA("ProximityPrompt") then return HttpService:JSONEncode({ success = false, error_code = "WRONG_CLASS", actual_class = target.ClassName }) end
    local available, promptState, elapsed = waitUntil(request.timeout_ms, request.poll_interval_ms, function()
      player = resolvePlayer(nil); local parent = target.Parent; local anchor = parent:IsA("Attachment") and parent.WorldPosition or parent:IsA("BasePart") and parent.Position or nil; local root = player and player.Character and (player.Character:FindFirstChild("HumanoidRootPart") or player.Character.PrimaryPart)
      return target.Enabled and anchor ~= nil and root ~= nil, { anchor = anchor, root = root, snapshot = playerSnapshot(nil) }
    end)
    if not available then return HttpService:JSONEncode({ success = false, error_code = "PROMPT_UNAVAILABLE", elapsed_ms = elapsed, enabled = target.Enabled, observed = promptState and promptState.snapshot or promptState }) end
    local anchor, root = promptState.anchor, promptState.root
    snapshot = playerSnapshot(nil)
    local distance = anchor and root and (root.Position - anchor).Magnitude or nil
    if not distance or distance > target.MaxActivationDistance then return HttpService:JSONEncode({ success = false, error_code = "PROMPT_OUT_OF_RANGE", distance = distance, max_activation_distance = target.MaxActivationDistance, snapshot = snapshot }) end
    if target.HoldDuration * 1000 + 50 > request.timeout_ms then return HttpService:JSONEncode({ success = false, error_code = "PROMPT_HOLD_EXCEEDS_DEADLINE", hold_duration = target.HoldDuration, deadline_ms = request.timeout_ms }) end
    target:InputHoldBegin(); if target.HoldDuration > 0 then task.wait(target.HoldDuration + 0.05) end; target:InputHoldEnd()
    return HttpService:JSONEncode({ success = true, dispatched = true, path = pathOf(target), enabled = target.Enabled, distance = distance, max_activation_distance = target.MaxActivationDistance, hold_duration = target.HoldDuration, requires_line_of_sight = target.RequiresLineOfSight, action_text = target.ActionText, object_text = target.ObjectText, keyboard_key_code = target.KeyboardKeyCode.Name })
  end
  if request.interaction == "click_detector" then
    if not target:IsA("ClickDetector") then return HttpService:JSONEncode({ success = false, error_code = "WRONG_CLASS", actual_class = target.ClassName }) end
    local parent = target.Parent; local point = parent:IsA("BasePart") and parent.Position or parent:IsA("Model") and parent:GetPivot().Position or nil
    local ready, clickState, elapsed = waitUntil(request.timeout_ms, request.poll_interval_ms, function()
      player = resolvePlayer(nil); local root = player and player.Character and (player.Character:FindFirstChild("HumanoidRootPart") or player.Character.PrimaryPart); local camera = workspace.CurrentCamera
      return point ~= nil and root ~= nil and camera ~= nil, { root = root, camera = camera, snapshot = playerSnapshot(nil) }
    end)
    if not ready then return HttpService:JSONEncode({ success = false, error_code = "CLICK_PREREQUISITE_UNAVAILABLE", elapsed_ms = elapsed, observed = clickState and clickState.snapshot or clickState }) end
    local root, camera = clickState.root, clickState.camera
    local distance = (root.Position - point).Magnitude; local projected, onScreen = camera:WorldToViewportPoint(point)
    if distance > target.MaxActivationDistance then return HttpService:JSONEncode({ success = false, error_code = "CLICK_OUT_OF_RANGE", distance = distance, max_activation_distance = target.MaxActivationDistance }) end
    if not onScreen or projected.Z <= 0 then return HttpService:JSONEncode({ success = false, error_code = "CLICK_TARGET_OFFSCREEN", projected = { projected.X, projected.Y, projected.Z } }) end
    local rayParams = RaycastParams.new(); rayParams.FilterType = Enum.RaycastFilterType.Exclude; rayParams.FilterDescendantsInstances = player.Character and { player.Character } or {}
    local hit = workspace:Raycast(camera.CFrame.Position, point - camera.CFrame.Position, rayParams)
    if hit and hit.Instance ~= parent and not hit.Instance:IsDescendantOf(parent) then return HttpService:JSONEncode({ success = false, error_code = "CLICK_TARGET_OCCLUDED", occluder_path = pathOf(hit.Instance), projected = { projected.X, projected.Y, projected.Z } }) end
    return HttpService:JSONEncode({ success = true, dispatch = "mouse", path = pathOf(target), x = math.floor(projected.X + 0.5), y = math.floor(projected.Y + 0.5), button = request.button, distance = distance, max_activation_distance = target.MaxActivationDistance, projected = { projected.X, projected.Y, projected.Z } })
  end
  if not (target:IsA("TextButton") or target:IsA("ImageButton")) then return HttpService:JSONEncode({ success = false, error_code = "WRONG_CLASS", actual_class = target.ClassName }) end
  local ready, guiState, elapsed = waitUntil(request.timeout_ms, request.poll_interval_ms, function()
    local visible, interactable = effectiveGui(target); local camera = workspace.CurrentCamera; return visible and interactable and target.Active and camera ~= nil, { visible = visible, interactable = interactable, active = target.Active, camera_available = camera ~= nil }
  end)
  if not ready then return HttpService:JSONEncode({ success = false, error_code = guiState and guiState.visible == false and "GUI_NOT_VISIBLE" or "GUI_NOT_INTERACTABLE", elapsed_ms = elapsed, observed = guiState }) end
  local visible, interactable, camera = guiState.visible, guiState.interactable, workspace.CurrentCamera; local position, size = target.AbsolutePosition, target.AbsoluteSize; local viewport = camera.ViewportSize
  if size.X <= 0 or size.Y <= 0 then return HttpService:JSONEncode({ success = false, error_code = "GUI_ZERO_SIZE", absolute_size = { size.X, size.Y } }) end
  local x, y = position.X + size.X * 0.5, position.Y + size.Y * 0.5
  if x < 0 or y < 0 or x >= viewport.X or y >= viewport.Y then return HttpService:JSONEncode({ success = false, error_code = "GUI_OFFSCREEN", click = { x, y }, viewport = { viewport.X, viewport.Y } }) end
  return HttpService:JSONEncode({ success = true, dispatch = "mouse", path = pathOf(target), x = math.floor(x + 0.5), y = math.floor(y + 0.5), button = "Left", active = target.Active, interactable = interactable, visible = visible, absolute_position = { position.X, position.Y }, absolute_size = { size.X, size.Y } })
end

if request.operation == "collect" then
  local watches, series = {}, {}
  for id, watch in pairs(state.watches) do
    if watch.kind == "property_change" then
      local target = resolvePath(watch.path)
      local ok, value = pcall(function() return target[watch.property] end)
      if ok then watch.final_value = serializeValue(value) end
    end
    local occurrenceCount = watch.kind == "instance_lifecycle" and watch.added_count or watch.count
    local record = { id = id, kind = watch.kind, context = watch.context, path = watch.path, occurrence_count = occurrenceCount, added_count = watch.added_count, removed_count = watch.removed_count, change_count = watch.kind == "property_change" and watch.count or nil, initial_value = watch.initial_value, final_value = watch.final_value, events = watch.events, dropped = watch.dropped, truncated = watch.dropped > 0, first_time = watch.events[1] and watch.events[1].time or nil, last_time = watch.events[#watch.events] and watch.events[#watch.events].time or nil }
    table.insert(watches, record)
  end
  for id, item in pairs(state.series) do
    local initial = item.samples[1] and item.samples[1].value or nil
    local final = item.samples[#item.samples] and item.samples[#item.samples].value or nil
    table.insert(series, { id = id, context = request.role, requested_interval_ms = item.requested_interval_ms, requested_duration_ms = item.requested_duration_ms, actual_interval_ms = item.actual_interval_ms, actual_duration_ms = item.actual_duration_ms, initial_value = initial, final_value = final, samples = item.samples, sample_count = #item.samples, dropped = item.dropped, missed = item.missed, truncated = item.dropped > 0, completed = item.completed })
  end
  table.sort(watches, function(a, b) return a.id < b.id end)
  table.sort(series, function(a, b) return a.id < b.id end)
  resetCurrent(state)
  return HttpService:JSONEncode({ success = true, watches = watches, series = series })
end

if request.operation == "reset" then
  resetCurrent(state)
  return HttpService:JSONEncode({ success = true, reset = true })
end

if request.operation == "cleanup" then
  disconnectState(state)
  local removed = false
  if state.marker then
    if state.marker:GetAttribute("RobloxAgentManagedEvidence") ~= true or state.marker:GetAttribute("RobloxAgentEvidenceSessionId") ~= request.session_id then error("REFUSING_UNMARKED_HARNESS_CLEANUP") end
    state.marker:Destroy(); removed = true
  end
  registry[request.session_id] = nil
  return HttpService:JSONEncode({ success = true, cleaned = true, marker_removed = removed })
end
error("unsupported evidence harness operation")
`;
}
