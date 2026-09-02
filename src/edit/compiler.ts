import type { EditInput } from '../tools/schemas.js';
import { payloadExpression } from '../runtime/luau.js';

type StructuredEditInput = Extract<EditInput, { operations: unknown[] }>;

export function compileEditBatch(input: StructuredEditInput): string {
  const payload = payloadExpression({ operations: input.operations, continueOnError: input.continue_on_error });
  return `
local HttpService = game:GetService("HttpService")
local payload = ${payload}
local refs = {}
local results = {}

local function pathSegment(name)
  if string.match(name, "^[A-Za-z_][A-Za-z0-9_]*$") then
    return "." .. name
  end
  return "[" .. HttpService:JSONEncode(name) .. "]"
end

local function instancePath(instance)
  if instance == game then return "game" end
  local segments = {}
  local cursor = instance
  while cursor and cursor ~= game do
    table.insert(segments, 1, pathSegment(cursor.Name))
    cursor = cursor.Parent
  end
  return "game" .. table.concat(segments, "")
end

local function child(parent, name)
  if parent == game then
    local ok, service = pcall(function() return game:GetService(name) end)
    if ok and service then return service end
  end
  return parent:FindFirstChild(name)
end

local function resolvePath(path)
  if string.sub(path, 1, 1) == "$" then
    local ref = refs[string.sub(path, 2)]
    if not ref then error("unknown batch reference " .. path) end
    return ref
  end
  local cursor
  local index
  if path == "game" then return game end
  if path == "workspace" then return workspace end
  if string.sub(path, 1, 4) == "game" then
    cursor = game
    index = 5
  elseif string.sub(path, 1, 9) == "workspace" then
    cursor = workspace
    index = 10
  else
    error("path must start with game or workspace: " .. path)
  end
  while index <= #path do
    local marker = string.sub(path, index, index)
    local name
    if marker == "." then
      local start = index + 1
      local finish = start
      while finish <= #path and string.match(string.sub(path, finish, finish), "[A-Za-z0-9_]") do
        finish = finish + 1
      end
      if finish == start then error("invalid dotted path segment in " .. path) end
      name = string.sub(path, start, finish - 1)
      index = finish
    elseif marker == "[" then
      if string.sub(path, index + 1, index + 1) ~= "\\\"" then error("bracket paths must use JSON double quotes in " .. path) end
      local quoteEnd
      local escaped = false
      for scan = index + 2, #path do
        local character = string.sub(path, scan, scan)
        if escaped then escaped = false
        elseif character == "\\\\" then escaped = true
        elseif character == "\\\"" then quoteEnd = scan; break end
      end
      if not quoteEnd or string.sub(path, quoteEnd + 1, quoteEnd + 1) ~= "]" then error("unterminated bracket path in " .. path) end
      local token = string.sub(path, index + 1, quoteEnd)
      local ok, decoded = pcall(function() return HttpService:JSONDecode(token) end)
      if not ok or type(decoded) ~= "string" then error("invalid bracket path segment in " .. path) end
      name = decoded
      index = quoteEnd + 2
    elseif marker == "/" then
      local closing = string.find(path, "/", index + 1, true) or (#path + 1)
      name = string.sub(path, index + 1, closing - 1)
      index = closing
    else
      error("invalid path syntax at character " .. tostring(index) .. " in " .. path)
    end
    cursor = child(cursor, name)
    if not cursor then error("instance not found: " .. path .. " (missing " .. name .. ")") end
  end
  return cursor
end

local function component(value, lower, upper, fallback)
  local found = value[lower]
  if found == nil then found = value[upper] end
  if found == nil then found = fallback end
  return found
end

local function convert(value)
  if type(value) ~= "table" then return value end
  local kind = value.type or value._type
  if not kind then
    local converted = {}
    for key, item in pairs(value) do converted[key] = convert(item) end
    return converted
  end
  if kind == "Vector3" then
    return Vector3.new(component(value, "x", "X", 0), component(value, "y", "Y", 0), component(value, "z", "Z", 0))
  elseif kind == "Vector2" then
    return Vector2.new(component(value, "x", "X", 0), component(value, "y", "Y", 0))
  elseif kind == "Color3" then
    return Color3.new(component(value, "r", "R", 0), component(value, "g", "G", 0), component(value, "b", "B", 0))
  elseif kind == "Color3RGB" then
    return Color3.fromRGB(component(value, "r", "R", 0), component(value, "g", "G", 0), component(value, "b", "B", 0))
  elseif kind == "CFrame" then
    if value.components then return CFrame.new(table.unpack(value.components)) end
    local p = value.position or {0, 0, 0}
    local r = value.rotationDegrees or value.rotation_degrees or {0, 0, 0}
    return CFrame.new(p[1], p[2], p[3]) * CFrame.fromOrientation(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
  elseif kind == "UDim" then
    return UDim.new(value.scale or 0, value.offset or 0)
  elseif kind == "UDim2" then
    if value.x and value.y then return UDim2.new(value.x[1], value.x[2], value.y[1], value.y[2]) end
    return UDim2.new(value.xScale or 0, value.xOffset or 0, value.yScale or 0, value.yOffset or 0)
  elseif kind == "Enum" then
    local enumName = value.enum
    local enumValue = value.value
    if type(enumName) ~= "string" or type(enumValue) ~= "string" then error("Enum needs enum and value") end
    enumName = string.gsub(enumName, "^Enum%.", "")
    local enumType = Enum[enumName]
    if not enumType or not enumType[enumValue] then error("invalid Enum." .. enumName .. "." .. enumValue) end
    return enumType[enumValue]
  elseif kind == "BrickColor" then
    return BrickColor.new(value.name or value.number)
  elseif kind == "NumberRange" then
    return NumberRange.new(value.min, value.max or value.min)
  elseif kind == "NumberSequence" then
    local points = {}
    for _, point in ipairs(value.keypoints or {}) do
      table.insert(points, NumberSequenceKeypoint.new(point.time, point.value, point.envelope or 0))
    end
    return NumberSequence.new(points)
  elseif kind == "ColorSequence" then
    local points = {}
    for _, point in ipairs(value.keypoints or {}) do
      local color = convert(point.color)
      table.insert(points, ColorSequenceKeypoint.new(point.time, color))
    end
    return ColorSequence.new(points)
  elseif kind == "Rect" then
    return Rect.new(convert(value.min), convert(value.max))
  elseif kind == "Ray" then
    return Ray.new(convert(value.origin), convert(value.direction))
  elseif kind == "PhysicalProperties" then
    return PhysicalProperties.new(value.density, value.friction, value.elasticity, value.frictionWeight, value.elasticityWeight)
  elseif kind == "Instance" then
    return resolvePath(value.path)
  end
  error("unsupported typed property value: " .. tostring(kind))
end

local function setSource(instance, source)
  if not instance:IsA("LuaSourceContainer") then error(instancePath(instance) .. " is not a script") end
  local editor = game:GetService("ScriptEditorService")
  local ok, updateError = pcall(function()
    editor:UpdateSourceAsync(instance, function() return source end)
  end)
  if not ok then
    local fallbackOk, fallbackError = pcall(function() instance.Source = source end)
    if not fallbackOk then error("source update failed: " .. tostring(updateError) .. "; fallback: " .. tostring(fallbackError)) end
  end
end

local function setProperties(instance, properties)
  for name, value in pairs(properties or {}) do instance[name] = convert(value) end
end

local function runOperation(operation)
  if operation.op == "create" then
    local parent = resolvePath(operation.parent)
    local instance = Instance.new(operation.class_name)
    local ok, createError = pcall(function()
      if operation.name then instance.Name = operation.name end
      setProperties(instance, operation.properties)
      if operation.source ~= nil then setSource(instance, operation.source) end
      instance.Parent = parent
    end)
    if not ok then instance:Destroy(); error(createError) end
    if operation.id then refs[operation.id] = instance end
    return { action = "created", class_name = instance.ClassName, path = instancePath(instance), id = operation.id }
  end
  local instance = resolvePath(operation.target)
  local beforePath = instancePath(instance)
  if operation.op == "modify" then
    setProperties(instance, operation.properties)
    for name, value in pairs(operation.attributes or {}) do instance:SetAttribute(name, convert(value)) end
    return { action = "modified", path = beforePath }
  elseif operation.op == "move" then
    instance.Parent = resolvePath(operation.parent)
    return { action = "moved", from = beforePath, path = instancePath(instance) }
  elseif operation.op == "rename" then
    instance.Name = operation.name
    return { action = "renamed", from = beforePath, path = instancePath(instance) }
  elseif operation.op == "delete" then
    instance:Destroy()
    return { action = "deleted", path = beforePath }
  elseif operation.op == "replace_script_source" then
    setSource(instance, operation.source)
    return { action = "source_replaced", path = beforePath, bytes = #operation.source }
  elseif operation.op == "patch_script" then
    if not instance:IsA("LuaSourceContainer") then error(beforePath .. " is not a script") end
    local source = instance.Source
    local firstStart, firstEnd = string.find(source, operation.old_text, 1, true)
    if not firstStart then error("patch old_text was not found") end
    if string.find(source, operation.old_text, firstEnd + 1, true) then error("patch old_text must match exactly once") end
    local updated = string.sub(source, 1, firstStart - 1) .. operation.new_text .. string.sub(source, firstEnd + 1)
    setSource(instance, updated)
    return { action = "source_patched", path = beforePath, bytes = #updated }
  end
  error("unsupported operation " .. tostring(operation.op))
end

local failed = false
for index, operation in ipairs(payload.operations) do
  local ok, value = pcall(runOperation, operation)
  if ok then
    table.insert(results, { index = index, success = true, result = value })
  else
    failed = true
    table.insert(results, { index = index, success = false, error = tostring(value) })
    if not payload.continueOnError then break end
  end
end

return HttpService:JSONEncode({ success = not failed, requested = #payload.operations, attempted = #results, results = results })
`;
}
