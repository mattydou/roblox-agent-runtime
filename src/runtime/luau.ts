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

export function parseExecuteResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed execute_luau response: ${JSON.stringify(value)}`);
  }
  const response = value as Record<string, unknown>;
  if (response.success === false) throw new Error(String(response.error ?? 'execute_luau failed'));
  const encoded = response.returnValue;
  if (typeof encoded !== 'string') {
    throw new Error(`execute_luau returned no JSON string: ${JSON.stringify(value)}`);
  }
  try {
    return JSON.parse(encoded);
  } catch (error) {
    throw new Error(`execute_luau returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type RuntimeInspectionRequest =
  | { mode: 'hierarchy'; path?: string; depth: number; scripts_only: boolean; max_results: number }
  | { mode: 'search'; query: string; search_by: 'name' | 'class'; max_results: number }
  | { mode: 'properties'; path: string; properties: string[] };

/** Compiles only bounded read operations; caller input is JSON data, never Luau source. */
export function compileRuntimeInspection(request: RuntimeInspectionRequest): string {
  const payload = payloadExpression(request);
  return `
local HttpService = game:GetService("HttpService")
local request = ${payload}
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
local function encode(value)
  local kind = typeof(value)
  if kind == "string" or kind == "number" or kind == "boolean" or kind == "nil" then return value end
  if kind == "Instance" then return { type = "Instance", path = pathOf(value) } end
  return { type = kind, value = tostring(value) }
end
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
    values[property] = ok and encode(value) or { error = tostring(value) }
  end
  results = { context_path = pathOf(instance), class_name = instance.ClassName, properties = values }
else error("unsupported runtime inspection mode") end
return HttpService:JSONEncode({ success = true, result = results })
`;
}
