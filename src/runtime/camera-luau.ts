import { payloadExpression, RUNTIME_PATH_HELPERS } from './luau.js';

export type CameraOperation =
  | { operation: 'snapshot'; target_path?: string; center?: [number, number, number]; radius?: number; padding: number; field_of_view: number }
  | { operation: 'apply'; center: [number, number, number]; basis_components: number[]; radius: number; azimuth: number; elevation: number; field_of_view: number; settle_frames: number; settle_timeout_ms: number }
  | { operation: 'restore'; snapshot: { camera_type: string; cframe: number[]; focus: number[]; field_of_view: number } };

/** Fixed camera program. The caller contributes only schema-validated JSON data. */
export function compileCameraOperation(request: CameraOperation): string {
  const payload = payloadExpression(request);
  return `
${RUNTIME_PATH_HELPERS}
local request = ${payload}
local camera = workspace.CurrentCamera
if not camera then error("CURRENT_CAMERA_UNAVAILABLE") end
local function vec(value) return Vector3.new(value[1], value[2], value[3]) end
local function cframe(value) return CFrame.new(table.unpack(value)) end
local function vector(value) return { value.X, value.Y, value.Z } end
local function components(value) return { value:GetComponents() } end
local function snapshot()
  return { camera_type = camera.CameraType.Name, cframe = components(camera.CFrame), focus = components(camera.Focus), field_of_view = camera.FieldOfView }
end
if request.operation == "snapshot" then
  local center, boundsSize, basis, targetPath
  if request.target_path then
    local target = resolvePath(request.target_path)
    if target:IsA("BasePart") then center, boundsSize, basis = target.Position, target.Size, target.CFrame
    elseif target:IsA("Model") then basis = target:GetPivot(); local bounds; bounds, boundsSize = target:GetBoundingBox(); center = bounds.Position
    else error("CONTROLLED_CAPTURE_TARGET_WRONG_CLASS:" .. target.ClassName) end
    targetPath = pathOf(target)
  else
    center, boundsSize, basis = vec(request.center), Vector3.zero, CFrame.new(vec(request.center))
  end
  local radius = request.radius
  if not radius then
    local halfDiagonal = math.max(boundsSize.Magnitude * 0.5, 0.5)
    radius = (halfDiagonal / math.tan(math.rad(request.field_of_view * 0.5))) * request.padding
  end
  return HttpService:JSONEncode({ success = true, snapshot = snapshot(), target = { path = targetPath, center = vector(center), bounds_size = vector(boundsSize), basis_components = components(basis), radius = radius } })
end
if request.operation == "apply" then
  local center = vec(request.center)
  local basis = cframe(request.basis_components)
  local azimuth, elevation = math.rad(request.azimuth), math.rad(request.elevation)
  local cosElevation = math.cos(elevation)
  local localOffset = Vector3.new(math.sin(azimuth) * cosElevation, math.sin(elevation), -math.cos(azimuth) * cosElevation)
  local offset = basis:VectorToWorldSpace(localOffset).Unit * request.radius
  local position = center + offset
  local forward = (center - position).Unit
  local up = math.abs(forward:Dot(Vector3.yAxis)) > 0.98 and basis:VectorToWorldSpace(Vector3.zAxis) or Vector3.yAxis
  camera.CameraType = Enum.CameraType.Scriptable
  camera.FieldOfView = request.field_of_view
  camera.CFrame = CFrame.lookAt(position, center, up)
  camera.Focus = CFrame.new(center)
  local frames, started = 0, os.clock()
  local connection = game:GetService("RunService").RenderStepped:Connect(function() frames += 1 end)
  repeat task.wait() until frames >= request.settle_frames or (os.clock() - started) * 1000 >= request.settle_timeout_ms
  connection:Disconnect()
  if frames < request.settle_frames then error("CAMERA_RENDER_SETTLE_TIMEOUT:" .. tostring(frames)) end
  return HttpService:JSONEncode({ success = true, settled_frames = frames, camera = { position = vector(camera.CFrame.Position), direction = vector(camera.CFrame.LookVector), field_of_view = camera.FieldOfView } })
end
if request.operation == "restore" then
  local ok, cameraType = pcall(function() return Enum.CameraType[request.snapshot.camera_type] end)
  if not ok or not cameraType then error("CAMERA_RESTORE_TYPE_INVALID") end
  camera.CameraType = cameraType
  camera.CFrame = cframe(request.snapshot.cframe)
  camera.Focus = cframe(request.snapshot.focus)
  camera.FieldOfView = request.snapshot.field_of_view
  return HttpService:JSONEncode({ success = true, restored = true, snapshot = snapshot() })
end
error("unsupported camera operation")
`;
}
