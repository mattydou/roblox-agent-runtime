# roblox-agent-runtime V1 design

## Evidence and version decision

The runtime wraps the public stdio MCP interface of
`@chrrxs/robloxstudio-mcp`; it does not import Chrrxs internals. The upstream
test harness starts the built server as a subprocess, sends newline-delimited
MCP JSON-RPC (`initialize`, `notifications/initialized`, `tools/call`), and
relies on Chrrxs primary/proxy mode when another subprocess already owns the
Studio plugin bridge. Chrrxs sends diagnostics to stderr and protocol data to
stdout. Its `capture_screenshot` tool returns an MCP `image` content block plus
structured/text metadata.

This project pins `@chrrxs/robloxstudio-mcp` **3.0.3**. The migration from
2.23.1 was inspected as compatibility work before changing the dependency:

- v3 removes `search_files`; script-content inspection now maps to
  `grep_scripts`, while object name/class/property inspection stays on
  `search_objects`.
- v3 removes `get_selection`; current selection now maps to
  `selection { action: "get" }`.
- v3's modern MCP response contract puts JSON in `structuredContent`; the
  adapter reads that first and retains JSON-text fallback for legacy protocol
  negotiation.
- v3.0.3 multiplexes Studio traffic over one event stream and makes response
  delivery idempotent. These are transparent below the supported stdio MCP
  boundary.
- screenshots may be downscaled before crossing HTTP/MCP size limits. The
  runtime preserves Chrrxs' image block and returned dimensions/coordinate
  mapping instead of assuming image pixels always equal native viewport pixels.

Roblox's current engine reference confirms:

- `KeyframeSequence` is an `AnimationClip` with `Loop` and `Priority`.
- `Keyframe`, `Pose`, and `KeyframeMarker` are the native authored hierarchy.
- `Pose.CFrame`, `PoseEasingStyle`, and `PoseEasingDirection` represent joint
  transforms and interpolation.
- `AnimationClipProvider:RegisterActiveAnimationClip(AnimationClip)` returns a
  temporary `ContentId`; `RegisterAnimationClip` also remains available.

V1 therefore uses `AnimationClipProvider:RegisterActiveAnimationClip`, not the
deprecated `KeyframeSequenceProvider` service and not permanent asset upload.

## Process architecture

```text
Cursor / Grok
  -> stdio MCP: roblox-agent-runtime (six public tools)
      -> stdio MCP: @chrrxs/robloxstudio-mcp@3.0.3
      -> Chrrxs localhost bridge
        -> existing Chrrxs Studio plugin
          -> Roblox Studio
```

The wrapper owns one Chrrxs child process. It initializes the child through
the supported MCP client transport, captures child stderr into
`.runtime/logs/chrrxs-stderr.log`, fails pending calls if the child exits, and
closes it when the wrapper's stdin closes or it receives a termination signal.
No Chrrxs stdout or wrapper diagnostics are written to the wrapper's MCP
stdout.

## Public MCP contract

Exactly these tool names are listed.

### `roblox_task`

Discriminated by `action`:

- `begin`: `goal`, optional `task_id`, optional initial `plan` and
  `requirements`.
- `set_plan`: replaces the plan and/or explicitly registered requirements.
- `mark_step`: changes one plan step's status.
- `record_observation`: appends a model-authored observation.
- `record_validation`: appends a validation/test record and may satisfy an
  explicitly named requirement.
- `status`: returns compact current state.
- `complete`: rejects completion while any registered step or requirement is
  incomplete.

Task JSON lives at `.runtime/tasks/<task-id>.json`; the active task id lives in
`.runtime/current-task.json`. The store never infers requirements from natural
language. Successful public operations append structured evidence and satisfy
only known capability requirements (`animation`, `animation_preview`,
`playtest`, `screenshot`) or requirements explicitly named by the caller.

### `roblox_inspect`

Discriminated by `mode`:

- `status` -> `get_connected_instances`, optionally `get_place_info`
- `hierarchy` -> `get_project_structure`
- `search` -> `search_objects` or `grep_scripts`
- `properties` -> `get_instance_properties`
- `scripts` -> `get_project_structure` with `scriptsOnly=true` or
  `grep_scripts`
- `script_source` -> `get_script_source`
- `selection` -> `selection` with `action="get"`
- `runtime` -> `get_runtime_logs`

Limits are applied both to the upstream request where supported and to a
deterministic recursive result compactor. This is data normalization, not an
AI-generated project summary.

### `roblox_edit`

Accepts an ordered `operations` array (maximum 100) with:

- `create`: class, parent path or earlier `$id`, optional stable batch id,
  name, properties, and script source.
- `modify`: target path or `$id`, property map, and optional attributes.
- `move`: target plus new parent.
- `rename`: target plus name.
- `delete`: target.
- `replace_script_source`: target plus complete source.
- `patch_script`: target, unique exact old text, replacement text.

The entire visible batch becomes one internal `execute_luau` call. The Luau
program is fixed runtime code; operations are JSON-decoded data, never
interpolated source. It supports canonical `game.Service.Child` and bracketed
paths plus `$id` references to objects created earlier in the same batch.
Typed property values cover common Roblox datatypes (vectors, colors, CFrame,
UDim/UDim2, enums, BrickColor, ranges/sequences, Rect, Ray, and Instance
references). Each operation reports success or failure. Default fail-fast
behavior preserves all prior results and never claims atomic rollback.

### `roblox_author`

V1 accepts only `kind="animation"` with:

- `operation="inspect_rig"` and an authoritative target rig path, or
  `operation="create"` with the animation definition;
- target rig path, artifact name, loop, priority, optional duration;
- ordered keyframes with non-negative times;
- pose entries referencing a discovered animated Part, Motor6D/animation-joint
  name, or canonical path returned by `inspect_rig`;
- position and Euler rotation in degrees, optional pose easing;
- keyframe event markers;
- preview mode `register` or `play`.

The caller's existing target rig is authoritative. The runtime never creates,
rebuilds, or substitutes a rig because a requested joint is unknown. Studio
derives a rooted animation hierarchy from the target's actual Motor6D and
AnimationConstraint connections without R6/R15 name tables. The normalized
manifest naturally exposes R6, R15, or custom names and canonical paths.

Normalized manifests are cached per Studio instance and target-rig path. A
creation call uses the cached canonical hierarchy and checks a lightweight
Studio-side structural fingerprint. A missing rig, changed fingerprint,
missing cached Part, or target-validation miss invalidates the entry, performs
one fresh inspection, and retries once when safe. Ordinary creation responses
contain only compact resolved targets/cache status; the full manifest is
returned only for explicit `inspect_rig` calls.

TypeScript validates the static definition and canonical targets, then creates
the full ancestor Pose hierarchy and persists the sequence under
`game.ServerStorage.RobloxAgentArtifacts.Animations`. It registers the
sequence with `AnimationClipProvider`, creates a sibling temporary `Animation`
reference, and optionally loads/plays it on the rig's `Animator`. The result
contains stable instance paths, the temporary Studio-local content id, and
separate registration/play status. The `active://` id is labeled
Studio-session-only, no published id is implied, and `deployment_ready` is
false. V1 never publishes an asset.

Explicit fixture acquire/cleanup operations remain inside this authoring
abstraction. Roblox creates a native R6/R15 model, the existing graph/cache
validates it, and cleanup refuses any rig without the managed marker. Optional
sampling resolves at most three marker/time requests. Edit sampling stops its
track in cleanup; playtest sampling uses and removes a marked replicated
KeyframeSequence harness without inserting scripts.

### `roblox_test`

- solo `start|status|stop` -> `solo_playtest`
- multiplayer `start|status|add_players|leave_client|stop` ->
  `multiplayer_playtest`
- action-sensitive independent per-role incremental logs -> `get_runtime_logs`

Start/status do not collect implicitly. Stop collects before peers disappear.
Per-role cursors advance below the model, and one stale capture yields a partial
response without discarding responsive peers. Only new entries are scanned for
runtime errors. A successful start records one playtest evidence item.

### `roblox_observe`

- `screenshot` -> `capture_screenshot`; the upstream MCP image block is
  preserved verbatim, alongside compact text metadata.
- `logs` -> `get_runtime_logs`.
- `state` -> edit `get_instance_properties`, or fixed bounded server/client
  evaluation for explicitly selected properties.

The wrapper does not describe or judge images.

## Telemetry

`.runtime/logs/model-visible.jsonl` records one row per public call and
`.runtime/logs/chrrxs-internal.jsonl` records one row per internal Chrrxs call.
Rows contain timestamp, active task id, tool/operation, duration, approximate
JSON request/response bytes, and success. Child stderr is separate. Telemetry
is never added to ordinary tool responses.

## Failure policy

- Public arguments are validated before Studio is touched.
- Chrrxs MCP errors, `isError` results, child termination, malformed upstream
  data, and per-operation Studio failures are surfaced.
- Edit batches are ordered and fail fast by default. V1 does not promise a
  transaction or rollback; the response identifies every operation completed
  before failure.
- Animation validation occurs both outside Studio and against the live rig.
- Runtime state writes are atomic file replacements.

## Known limitations

- No permanent animation publishing.
- Temporary animation content ids are scoped to the current Studio session.
- Edit batches are not atomic across a mid-batch failure.
- Animation V1 targets part-based Motor6D/AnimationConstraint hierarchies;
  bone and curve animation authoring remains out of scope.
- Visual quality is judged by the frontier model, not this runtime.
- Chrrxs v3.0.3 may downscale oversized screenshots. Callers must retain its
  returned native/captured dimensions and coordinate-scale guidance.

## Explicit non-goals

No LLM calls, second agent, RAG, GUI, service/daemon, custom Studio plugin,
custom synchronization layer, feature-specific workflow tools, unrestricted
public Luau execution, asset publishing, or specialized VFX/UI/terrain/audio
authoring are included in V1.
