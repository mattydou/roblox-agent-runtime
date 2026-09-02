export function longBracket(value: string): string {
  for (let equals = 0; equals < 20; equals += 1) {
    const marker = '='.repeat(equals);
    const closing = `]${marker}]`;
    if (!value.includes(closing)) return `[${marker}[${value}]${marker}]`;
  }
  throw new Error('Unable to encode payload as a Luau long-bracket string');
}

export function payloadExpression(value: unknown): string {
  return `game:GetService("HttpService"):JSONDecode(${longBracket(JSON.stringify(value))})`;
}

export const CALLER_LUAU_SOURCE_MAX_BYTES = 50_000;
export const CALLER_LUAU_RESULT_MAX_BYTES = 64_000;
export const CALLER_LUAU_TIMEOUT_MIN_MS = 1_000;
export const CALLER_LUAU_TIMEOUT_MAX_MS = 30_000;

/**
 * Wraps caller Luau in a bounded result envelope. The source still has the
 * normal authority of its fixed Studio execution context; the envelope bounds
 * only routing, duration (at the transport), and what is returned to the model.
 */
export function compileCallerLuau(source: string): string {
  return `
local HttpService = game:GetService("HttpService")
local MAX_RESULT_BYTES = ${CALLER_LUAU_RESULT_MAX_BYTES}
local function normalize(value, depth, seen)
  local kind = typeof(value)
  if kind == "nil" then return { type = "nil" } end
  if kind == "string" then
    if #value > 4000 then return string.sub(value, 1, 4000) .. "...[truncated]" end
    return value
  end
  if kind == "number" or kind == "boolean" then return value end
  if kind == "EnumItem" then return { type = "Enum", enum = tostring(value.EnumType), value = value.Name } end
  if kind == "Vector2" then return { type = "Vector2", x = value.X, y = value.Y } end
  if kind == "Vector3" then return { type = "Vector3", x = value.X, y = value.Y, z = value.Z } end
  if kind == "CFrame" then return { type = "CFrame", components = { value:GetComponents() } } end
  if kind == "Color3" then return { type = "Color3", r = value.R, g = value.G, b = value.B } end
  if kind == "UDim" then return { type = "UDim", scale = value.Scale, offset = value.Offset } end
  if kind == "UDim2" then return { type = "UDim2", x = { value.X.Scale, value.X.Offset }, y = { value.Y.Scale, value.Y.Offset } } end
  if kind == "Instance" then
    return { type = "Instance", name = string.sub(value.Name, 1, 200), class_name = value.ClassName, path = string.sub(value:GetFullName(), 1, 1000) }
  end
  if kind ~= "table" then return { type = "unsupported", roblox_type = kind } end
  if depth >= 6 then return "[max depth reached]" end
  if seen[value] then return "[circular]" end
  seen[value] = true
  local output, count = {}, 0
  for key, item in pairs(value) do
    count += 1
    if count > 80 then output._truncated = true break end
    local normalizedKey = type(key) == "string" and string.sub(key, 1, 200) or tostring(key)
    output[normalizedKey] = normalize(item, depth + 1, seen)
  end
  seen[value] = nil
  return output
end
local ok, result = xpcall(function()
${source}
end, function(message) return tostring(message) end)
if not ok then
  return HttpService:JSONEncode({ success = false, error_code = "CALLER_LUAU_FAILED", error = string.sub(result, 1, 1000) })
end
local encoded = HttpService:JSONEncode({ success = true, value = normalize(result, 0, {}) })
if #encoded > MAX_RESULT_BYTES then
  return HttpService:JSONEncode({ success = false, error_code = "LUAU_RESULT_TOO_LARGE", observed_bytes = #encoded, limit_bytes = MAX_RESULT_BYTES })
end
return encoded
`;
}

export function parseExecuteResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed execute_luau response: ${JSON.stringify(value)}`);
  }
  const response = value as Record<string, unknown>;
  if (response.success === false || response.ok === false) throw new Error(String(response.error ?? response.message ?? 'runtime evaluation failed'));
  const encoded = typeof response.returnValue === 'string' ? response.returnValue : response.result;
  if (typeof encoded !== 'string') {
    throw new Error(`Studio evaluation returned no JSON string: ${JSON.stringify(value)}`);
  }
  try {
    return JSON.parse(encoded);
  } catch (error) {
    throw new Error(`Studio evaluation returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const RUNTIME_PATH_HELPERS = String.raw`
local HttpService = game:GetService("HttpService")
local function child(parent, name)
  if parent == game then
    local ok, service = pcall(function() return game:GetService(name) end)
    if ok and service then return service end
  end
  return parent:FindFirstChild(name)
end
local function resolvePath(path)
  path = path or "game"
  if path == "workspace" then return workspace end
  if path == "game" then return game end
  local cursor, index
  if string.sub(path, 1, 4) == "game" then cursor, index = game, 5
  elseif string.sub(path, 1, 9) == "workspace" then cursor, index = workspace, 10
  else error("path must start with game or workspace") end
  while index <= #path do
    local marker, name = string.sub(path, index, index), nil
    if marker == "." then
      local start, finish = index + 1, index + 1
      while finish <= #path and string.match(string.sub(path, finish, finish), "[A-Za-z0-9_]") do finish += 1 end
      if finish == start then error("invalid dotted path") end
      name, index = string.sub(path, start, finish - 1), finish
    elseif marker == "[" and string.sub(path, index + 1, index + 1) == "\\\"" then
      local quoteEnd, escaped = nil, false
      for scan = index + 2, #path do
        local character = string.sub(path, scan, scan)
        if escaped then escaped = false elseif character == "\\\\" then escaped = true elseif character == "\\\"" then quoteEnd = scan break end
      end
      if not quoteEnd or string.sub(path, quoteEnd + 1, quoteEnd + 1) ~= "]" then error("unterminated bracket path") end
      local ok, decoded = pcall(function() return HttpService:JSONDecode(string.sub(path, index + 1, quoteEnd)) end)
      if not ok or type(decoded) ~= "string" then error("invalid bracket path") end
      name, index = decoded, quoteEnd + 2
    else error("invalid path syntax") end
    cursor = child(cursor, name)
    if not cursor then error("instance not found: " .. path) end
  end
  return cursor
end
local function segment(name)
  if string.match(name, "^[A-Za-z_][A-Za-z0-9_]*$") then return "." .. name end
  return "[" .. HttpService:JSONEncode(name) .. "]"
end
local function pathOf(instance)
  local pieces, cursor = {}, instance
  while cursor and cursor ~= game do table.insert(pieces, 1, segment(cursor.Name)); cursor = cursor.Parent end
  return "game" .. table.concat(pieces, "")
end
`;

export const RUNTIME_SERIALIZER = String.raw`
local function serializeValue(value)
  local kind = typeof(value)
  if kind == "nil" then return { type = "nil" } end
  if kind == "string" then
    local truncated = #value > 1000
    return truncated and { type = "string", value = string.sub(value, 1, 1000), truncated = true } or value
  end
  if kind == "number" or kind == "boolean" then return value end
  if kind == "EnumItem" then return { type = "Enum", enum = tostring(value.EnumType), value = value.Name } end
  if kind == "Vector2" then return { type = "Vector2", x = value.X, y = value.Y } end
  if kind == "Vector3" then return { type = "Vector3", x = value.X, y = value.Y, z = value.Z } end
  if kind == "CFrame" then return { type = "CFrame", components = { value:GetComponents() } } end
  if kind == "Color3" then return { type = "Color3", r = value.R, g = value.G, b = value.B } end
  if kind == "UDim" then return { type = "UDim", scale = value.Scale, offset = value.Offset } end
  if kind == "UDim2" then return { type = "UDim2", x = { value.X.Scale, value.X.Offset }, y = { value.Y.Scale, value.Y.Offset } } end
  if kind == "BrickColor" then return { type = "BrickColor", name = value.Name, number = value.Number } end
  if kind == "Instance" then return { type = "Instance", path = pathOf(value), class_name = value.ClassName } end
  return { type = "unsupported", roblox_type = kind }
end
`;

export type RuntimeInspectionRequest =
  | { mode: 'hierarchy'; path?: string; depth: number; scripts_only: boolean; max_results: number }
  | { mode: 'search'; query: string; search_by: 'name' | 'class'; max_results: number }
  | { mode: 'properties'; path: string; properties: string[] };

/** Compiles only bounded read operations; caller input is JSON data, never Luau source. */
export function compileRuntimeInspection(request: RuntimeInspectionRequest): string {
  const payload = payloadExpression(request);
  return `
${RUNTIME_PATH_HELPERS}
${RUNTIME_SERIALIZER}
local request = ${payload}
local results = {}
local maxScanned = math.min(10000, math.max(100, (request.max_results or #request.properties or 1) * 100))
if request.mode == "hierarchy" then
  local root = resolvePath(request.path)
  local queue, head = {{ instance = root, depth = 0 }}, 1
  while head <= #queue and head <= maxScanned and #results < request.max_results do
    local item = queue[head] head += 1
    if not request.scripts_only or item.instance:IsA("LuaSourceContainer") then
      table.insert(results, { path = pathOf(item.instance), name = item.instance.Name, class_name = item.instance.ClassName, depth = item.depth })
    end
    if item.depth < request.depth then
      local children = item.instance:GetChildren()
      table.sort(children, function(a, b) return pathOf(a) < pathOf(b) end)
      for _, descendant in ipairs(children) do
        if #queue >= maxScanned then break end
        table.insert(queue, { instance = descendant, depth = item.depth + 1 })
      end
    end
  end
elseif request.mode == "search" then
  local needle = string.lower(request.query)
  local candidates, head = game:GetChildren(), 1
  table.sort(candidates, function(a, b) return pathOf(a) < pathOf(b) end)
  while head <= #candidates and head <= maxScanned do
    local instance = candidates[head] head += 1
    local haystack = request.search_by == "class" and instance.ClassName or instance.Name
    if string.find(string.lower(haystack), needle, 1, true) then
      table.insert(results, { path = pathOf(instance), name = instance.Name, class_name = instance.ClassName })
      if #results >= request.max_results then break end
    end
    local children = instance:GetChildren()
    table.sort(children, function(a, b) return pathOf(a) < pathOf(b) end)
    for _, childInstance in ipairs(children) do
      if #candidates >= maxScanned then break end
      table.insert(candidates, childInstance)
    end
  end
elseif request.mode == "properties" then
  local instance = resolvePath(request.path)
  local values = {}
  for _, property in ipairs(request.properties) do
    local ok, value = pcall(function() return instance[property] end)
    values[property] = ok and serializeValue(value) or { type = "property_error", message = string.sub(tostring(value), 1, 500) }
  end
  results = { context_path = pathOf(instance), class_name = instance.ClassName, properties = values }
else error("unsupported runtime inspection mode") end
return HttpService:JSONEncode({ success = true, result = results })
`;
}

export interface GuiInspectionRequest {
  path: string;
  depth: number;
  max_results: number;
  interactive_only: boolean;
  static_context: boolean;
}

/** Fixed bounded GUI serializer; request values are JSON data, never source. */
export function compileGuiInspection(request: GuiInspectionRequest): string {
  const payload = payloadExpression(request);
  return `
${RUNTIME_PATH_HELPERS}
local request = ${payload}
local root = resolvePath(request.path)
local camera = workspace.CurrentCamera
local viewport = camera and camera.ViewportSize or Vector2.zero
local results, visited, truncated = {}, 0, false
local function readable(instance, property)
  local ok, value = pcall(function() return instance[property] end)
  return ok and value or nil
end
local function effective(instance)
  local visible, enabled = true, true
  local cursor = instance
  while cursor and cursor ~= game do
    if cursor:IsA("GuiObject") and cursor.Visible == false then visible = false end
    if cursor:IsA("LayerCollector") and readable(cursor, "Enabled") == false then enabled = false end
    cursor = cursor.Parent
  end
  return visible and enabled
end
local function visit(instance, depth, parentPath)
  if visited >= request.max_results then truncated = true return end
  local isGui = instance:IsA("GuiObject") or instance:IsA("LayerCollector")
  local isButton = instance:IsA("TextButton") or instance:IsA("ImageButton")
  if isGui and (not request.interactive_only or isButton) then
    local position = readable(instance, "AbsolutePosition")
    local size = readable(instance, "AbsoluteSize")
    local directEnabled, directVisible = nil, nil
    if instance:IsA("LayerCollector") then directEnabled = readable(instance, "Enabled") end
    if instance:IsA("GuiObject") then directVisible = instance.Visible end
    local intersects = nil
    if position and size and viewport.X > 0 and viewport.Y > 0 then
      intersects = size.X > 0 and size.Y > 0 and position.X < viewport.X and position.Y < viewport.Y and position.X + size.X > 0 and position.Y + size.Y > 0
    end
    local record = {
      path = pathOf(instance), parent_path = parentPath, name = instance.Name, class_name = instance.ClassName, depth = depth,
      enabled = directEnabled, visible = directVisible, effective_visible = effective(instance),
      active = readable(instance, "Active"), interactable = readable(instance, "Interactable"), selectable = readable(instance, "Selectable"),
      text = (instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox")) and string.sub(instance.Text, 1, 500) or nil,
      image = (instance:IsA("ImageLabel") or instance:IsA("ImageButton")) and string.sub(instance.Image, 1, 500) or nil,
      hover_image = instance:IsA("ImageButton") and string.sub(instance.HoverImage, 1, 500) or nil,
      pressed_image = instance:IsA("ImageButton") and string.sub(instance.PressedImage, 1, 500) or nil,
      absolute_position = position and { position.X, position.Y } or nil, absolute_size = size and { size.X, size.Y } or nil,
      rotation = readable(instance, "Rotation"), z_index = readable(instance, "ZIndex"), display_order = readable(instance, "DisplayOrder"),
      viewport_intersects = intersects, is_button = isButton,
    }
    table.insert(results, record); visited += 1
  end
  if depth >= request.depth then return end
  local children = instance:GetChildren()
  table.sort(children, function(a, b) if a.Name == b.Name then return a.ClassName < b.ClassName end return a.Name < b.Name end)
  local canonical = isGui and pathOf(instance) or parentPath
  for _, child in ipairs(children) do visit(child, depth + 1, canonical); if visited >= request.max_results then truncated = #children > 0 return end end
end
visit(root, 0, nil)
return HttpService:JSONEncode({ success = true, context = request.static_context and "edit" or "client-1", layout_authority = request.static_context and "static" or "runtime", root_path = pathOf(root), viewport_size = { viewport.X, viewport.Y }, results = results, truncated = truncated, max_results = request.max_results })
`;
}
