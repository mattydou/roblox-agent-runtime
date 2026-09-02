# roblox-agent-runtime

`roblox-agent-runtime` 0.5.0 is a deterministic research MVP that places a small,
stateful development interface in front of Roblox Studio. The frontier model
sees six semantic tools; the runtime translates those calls into the supported
MCP interface of Chrrxs' Roblox Studio server.

```text
Cursor / Grok
  -> roblox-agent-runtime (six tools)
    -> @chrrxs/robloxstudio-mcp@3.0.3
      -> existing Chrrxs Studio plugin
        -> Roblox Studio
```

There is no LLM, reasoning agent, custom Studio plugin, daemon, GUI, RAG, or
feature-specific workflow in this repository. See [DESIGN.md](DESIGN.md) for
the implementation contract and evidence behind the mappings.

## Version pin

This experiment pins `@chrrxs/robloxstudio-mcp` to **3.0.3** in both
`package.json` and the baseline configuration. The upgrade from 2.23.1 was
reviewed as an explicit compatibility change: removed upstream tools were
remapped, the v3 structured-result contract is supported, and the transport
and screenshot changes are documented in [DESIGN.md](DESIGN.md). Keep this pin
fixed across baseline and treatment runs so results remain comparable.

Upstream references:

- [Chrrxs repository](https://github.com/Chrrxs/robloxstudio-mcp)
- [v3.0.3 release](https://github.com/Chrrxs/robloxstudio-mcp/releases/tag/v3.0.3)
- [v3 removed-tool migration guide](https://github.com/Chrrxs/robloxstudio-mcp/blob/v3.0.3/docs/deprecated-api.md)
- [Roblox AnimationClipProvider](https://create.roblox.com/docs/reference/engine/classes/AnimationClipProvider)
- [Roblox KeyframeSequence](https://create.roblox.com/docs/reference/engine/classes/KeyframeSequence)

## Prerequisites

- Node.js 20.11 or newer.
- Roblox Studio open with HTTP Requests enabled as required by Chrrxs.
- The Chrrxs plugin matching v3.0.3 installed and activated.

Install the matching plugin once, then fully close and reopen Studio:

```powershell
npx -y @chrrxs/robloxstudio-mcp@3.0.3 --install-plugin
```

The runtime does not modify the plugin by default. Passing
`--auto-install-plugin` to `dist/server.js`, or setting
`ROBLOX_AGENT_AUTO_INSTALL_PLUGIN=1`, opts into Chrrxs' supported matching
plugin installer.

## Install and verify

```powershell
npm install
npm run build
npm test
```

`npm test` builds the project, runs unit and mocked-adapter coverage, and starts
the real pinned Chrrxs subprocess through the wrapper to prove valid stdio MCP
initialization and that only six tools are listed. It does not require Studio
and does not claim live Studio behavior.

Run the server directly:

```powershell
node .\dist\server.js
```

All diagnostics go to stderr. MCP protocol data is the only data written to
stdout.

## Restore on a clean Windows installation

Install Git and Node.js 20.11 or newer, then restore the complete source tree
and the exact locked dependency versions from GitHub:

```powershell
git clone https://github.com/mattydou/roblox-agent-runtime.git
Set-Location .\roblox-agent-runtime
npm ci
npm test
```

Install the pinned Studio plugin, fully close and reopen Roblox Studio, and
enable HTTP Requests as required by Chrrxs:

```powershell
npx -y @chrrxs/robloxstudio-mcp@3.0.3 --install-plugin
```

The repository contains all source, tests, documentation, examples, and the
dependency lockfile required to rebuild `dist`. The ignored `node_modules`,
`dist`, and `.runtime` directories are generated locally. In particular,
`.runtime` holds disposable task state and logs; it is not required to build or
run the server and is intentionally not published to GitHub.

## Cursor treatment configuration

Copy [examples/cursor-treatment.json](examples/cursor-treatment.json), replace
the two absolute paths, and use it as Cursor's MCP configuration. During the
treatment, this must be the only Roblox MCP server exposed to Grok:

```json
{
  "mcpServers": {
    "roblox-agent-runtime": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\roblox-agent-runtime\\dist\\server.js"],
      "env": {
        "ROBLOX_AGENT_RUNTIME_DIR": "C:\\absolute\\path\\to\\experiment-workspace\\.runtime"
      }
    }
  }
}
```

The wrapper starts `@chrrxs/robloxstudio-mcp@3.0.3` itself over stdio. Chrrxs
will become the primary bridge on port 58741 or use its supported proxy mode if
another Chrrxs process already owns that port. Do not separately list Chrrxs in
the treatment configuration.

## Baseline configuration

For the baseline, disable the treatment server and expose the same pinned
Chrrxs version directly. See
[examples/cursor-baseline.json](examples/cursor-baseline.json):

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@chrrxs/robloxstudio-mcp@3.0.3"]
    }
  }
}
```

Use `--auto-install-plugin` in either condition only when you intentionally
want Chrrxs to install/update its plugin.

## Six public tools

- `roblox_task`: optional persistent research bookkeeping with compact default
  responses. Completion gates only for explicit `enforcement="enforced"` tasks.
- `roblox_inspect`: compact edit/server/client hierarchy, name/class search,
  selected properties, scripts, selection, bounded GUI facts, and runtime logs.
- `roblox_edit`: precise structured operations or bounded edit-context Luau for
  compact repetitive construction. Create operations may define an `id`; later
  structured operations reference it as `$id`.
- `roblox_author`: inspect an authoritative R6, R15, or custom part-based rig,
  explicitly acquire/clean marked test fixtures, persist a native
  `KeyframeSequence`, and optionally preview it in a managed runtime context.
- `roblox_test`: one-shot or reusable managed Solo evidence with granular
  readiness, fixed-role server/client-1 Luau, native interactions/positioning,
  screenshots, assertions, incremental logs, and owned cleanup.
- `roblox_observe`: unchanged current-viewport screenshots, controlled
  target-centric multi-view capture, logs, or targeted state.

The model never sees Chrrxs' tool list or chooses a raw Chrrxs peer. V4 exposes
bounded native Luau only inside the existing edit and managed-test owners:

> Use semantic infrastructure where it creates guarantees; use bounded native
> Luau where it is the clearest and cheapest representation.

### V4 efficient paths

Use structured editing for a small, inspectable existing-place change:

```json
{"operations":[{"op":"modify","target":"game.Workspace.Door","properties":{"Anchored":true}}]}
```

Use edit Luau for loops, cloning, templates, and repetitive greenfield work:

```json
{"source":"local root=Instance.new('Folder'); root.Name='Generated'; root.Parent=workspace\nfor i=1,8 do local p=Instance.new('Part'); p.Name=`Part{i}`; p.Position=Vector3.new(i*4,2,0); p.Parent=root end\nreturn {created=8,root=root}","timeout_ms":15000}
```

Edit Luau is fixed to edit context, limited to 50,000 source bytes, 30 seconds,
and a 64,000-byte normalized result. It is never retried. Because caller code
may mutate before throwing, every execution attempt advances the wrapper
revision and stales active managed sessions; an error is not described as
transactional or mutation-free.

For short verification, use one `run_scenario`. This acquires Play internally,
runs a bounded mixed batch, captures final incremental logs, releases held
input, removes harness state, and stops only runtime-owned Play:

```json
{"mode":"solo","action":"run_scenario","required_roles":["server","client-1"],"batch":{"actions":[{"id":"request","kind":"luau","role":"client-1","source":"game.ReplicatedStorage.Ping:FireServer(); return true"},{"kind":"wait","duration_ms":150},{"id":"count","kind":"luau","role":"server","source":"return workspace:GetAttribute('PingCount')"},{"kind":"screenshot"}],"assertions":[{"id":"requestSent","evidence":"request","condition":"equals","expected":true},{"id":"serverObserved","evidence":"count","condition":"equals","expected":1}]}}
```

For a player-facing state changed by held input, keep input-down, a short wait,
the screenshot, and input-up in the same scenario so cleanup is guaranteed.
Images remain direct MCP blocks for the model/user to judge; the runtime does
not score aesthetics. Use controlled edit views for world composition, but
prefer one runtime client screenshot for first-person presentation or runtime
GUI. Do not make a visual call when the task has no visual acceptance criterion.

Explicit `begin_session` -> one or more `run_batch` calls -> `finish_session`
remains the long-lived path for multi-batch work. Short work should not begin or
manually advance a `roblox_task`; task state is opt-in for persistence,
enforcement, recovery, or handoff. Evidence is still recorded automatically
when a task is already active.

### Edit-mode-first workflow and controlled views

Author persistent scene content with `roblox_edit`/`roblox_author`, inspect it in
edit mode, capture controlled views, and revise/package before starting Play.
Use Play only when the evidence depends on runtime execution. The runtime makes
this path discoverable but never blocks a caller from starting Play.

`mode="screenshot"` remains the compatibility path and captures whichever
viewport Chrrxs currently selects. `mode="views"` instead owns a transient
camera operation, validates everything before moving it, captures in order, and
restores CameraType, CFrame, Focus, and FieldOfView in `finally`:

```json
{
  "mode": "views",
  "context": "edit",
  "target_path": "game.Workspace.DistantModel",
  "basis": "target",
  "views": [
    { "preset": "front" }, { "preset": "rear" },
    { "preset": "left" }, { "preset": "overhead" },
    { "preset": "front_right" }
  ]
}
```

Presets are deterministic azimuth/elevation degrees: `front` 0/0, `rear`
180/0, `left` -90/0, `right` 90/0, `overhead` 0/89.5,
`front_right` 45/25, `front_left` -45/25, `rear_right` 135/25,
`rear_left` -135/25, and `lower_front` 0/-20. Custom views supply bounded
`azimuth`/`elevation`. A target path accepts BasePart/Model and auto-fits radius
from bounds when omitted. An explicit `center` requires `radius` and
`basis="world"`. Camera positions lie on that sphere and look at the center.

Controlled capture supports edit and `client-1` only, never starts/stops Play,
and never advances wrapper revision. Because Chrrxs 3.0.3 auto-routes capture
to the first runtime client, edit capture fails closed with
`EDIT_CAPTURE_UNAVAILABLE_DURING_PLAYTEST` when client-1 is connected. At most
six JPEGs or two PNGs are returned. The first content block is an ordered JSON
manifest; successful images follow in request order, including on partial
failure. `restore_viewport=false` is honored only after complete success.

### Minimal GUI inspection

Use edit/static inspection for authored StarterGui hierarchy and properties:

```json
{ "mode": "gui", "context": "edit", "path": "game.StarterGui", "depth": 4, "max_results": 50 }
```

Use `context="client-1"` for actual PlayerGui absolute bounds/effective
visibility. Results are ordered and bounded, include only hierarchy,
enabled/visible/interactable state, text/image references, bounds, rotation,
Z/display order, button identity, viewport intersection, and explicit
truncation. Edit/static bounds are not claimed to equal runtime layout;
screenshots remain visual authority.

### Typed edit properties

Primitive JSON values work directly. Common Roblox datatypes use an explicit
tag, for example:

```json
{
  "operations": [
    {
      "op": "create",
      "id": "projectile",
      "class_name": "Part",
      "parent": "game.Workspace",
      "name": "Projectile",
      "properties": {
        "Anchored": true,
        "Size": { "type": "Vector3", "x": 2, "y": 2, "z": 2 },
        "Color": { "type": "Color3RGB", "r": 255, "g": 96, "b": 24 },
        "Material": { "type": "Enum", "enum": "Material", "value": "Neon" }
      }
    }
  ]
}
```

The public schema enumerates and strictly validates `Vector2`, `Vector3`, `Color3`, `Color3RGB`,
`CFrame`, `UDim`, `UDim2`, `Enum`, `BrickColor`, `NumberRange`,
`NumberSequence`, `ColorSequence`, `Rect`, `Ray`, `PhysicalProperties`, and an
`Instance` path reference. Batches are fail-fast by default and report every
attempt; they are not transactional.

### Managed evidence sessions

Use `run_scenario` for a one-call check or begin a reusable session and run
several batches against one playtest snapshot:

```json
{ "mode": "solo", "action": "begin_session", "play_mode": "play", "required_roles": ["server", "client-1"] }
```

`session.status="ready"` means only that the requested lifecycle peers and
fixed harnesses are healthy. The same successful result can report
`runtime_state.character_available=false`, because Player, Character,
Humanoid/root, Backpack, bounded Tool inventory, and equipped Tools are a
separate granular snapshot. Actions wait for only the state they require; a
server probe does not wait for a Character and keyboard input does not wait for
a Backpack. `session_status` refreshes this snapshot, but repeated model-side
polling is unnecessary when an action has its own prerequisite wait.

Reuse the returned `session.id`:

```json
{
  "mode": "solo",
  "action": "run_batch",
  "session_id": "<session UUID>",
  "batch": {
    "checkpoints": [{
      "id": "after",
      "phase": "after",
      "probes": [{
        "id": "door_exists",
        "kind": "exists",
        "context": "server",
        "path": "game.Workspace.Door"
      }]
    }],
    "watches": [{
      "id": "activated",
      "kind": "signal",
      "context": "client-1",
      "path": "game.Workspace.TestTool",
      "signal": "Activated"
    }],
    "actions": [{ "kind": "wait", "duration_ms": 100 }],
    "assertions": [
      { "id": "door_present", "evidence": "door_exists", "condition": "exists" },
      { "id": "no_activation", "evidence": "activated", "condition": "zero_occurrences" }
    ]
  }
}
```

Finish explicitly to collect final logs while peers still exist, release held
keys/buttons, remove marked harnesses, and stop a runtime-owned playtest:

```json
{ "mode": "solo", "action": "finish_session", "session_id": "<session UUID>" }
```

Supported actions are bounded wait/`wait_for`, client keyboard/mouse, verified
exact Tool equip/activate/unequip, runtime positioning, exact ProximityPrompt,
ClickDetector, and GuiButton interactions, plus optional raw screenshot capture.
Tool activate preserves auto-equip compatibility with `auto_equip=true` by
default, verifies the Tool reaches Character, and reports dispatch—not arbitrary
gameplay success. Point probes cover exact existence, one selected property,
and filtered descendant count. Watches cover descendant add/remove, a verified
`RBXScriptSignal` occurrence count without payloads, and property change
initial/final/count. Time series reuse the same existence/count/property probes.

Assertions are limited to equals/not-equals, exists/absent,
unchanged/changed, exact/minimum/maximum count, exact/minimum/maximum numeric
delta with explicit tolerance, and zero/at-least-one occurrence. Missing
evidence is a failure state, not a passing negative assertion. Behavioral
failures retain their evidence and are distinct from transport/harness failures.

Per batch the public schema allows at most 20 actions, 10 seconds of explicit
wait, 8 watches, 4 concurrent series, 10 checkpoints/50 probes, and 20
assertions. A series lasts at most 10 seconds, samples every 50–2000 ms, and
contains at most 100 samples; one session admits at most 500 returned samples
and retains at most 20 batch reports. Event lists are capped at 50 and oversized
reports are explicitly truncated around 128 KB. Screenshot bytes are returned
only as MCP image blocks, never embedded in JSON evidence.

Acquire proper reusable fixtures through the generic author form (the legacy
animation fixture operations remain aliases):

```json
{ "kind": "fixture", "operation": "acquire", "fixture": { "rig_type": "R15", "name": "AgentFixture", "position": [0, 3, 0] } }
```

After Play starts, position that fixture relative to the player's actual live
Character pivot without relocating the player:

```json
{
  "kind": "position", "context": "server",
  "subject": { "kind": "path", "path": "game.Workspace.AgentFixture" },
  "destination": { "kind": "character", "player": "ExactPlayerName" },
  "offset": [0, 0, -8], "offset_space": "anchor",
  "orientation": { "kind": "face_path", "path": "game.Players.ExactPlayerName.Character" }
}
```

Subject/destination resolution occurs at action time. Models use `PivotTo`,
BaseParts use CFrame, and read-back reports requested/actual position, distance,
facing, and tolerance. Relocating a Character requires selecting it explicitly
as the subject; session start never moves a player. Cleanup routes back through
the marked fixture owner and refuses unmarked rigs.

Primitive-specific interaction variants never guess target type. Prompt uses
the exact native `InputHoldBegin`/`InputHoldEnd` path with enabled/range/hold
facts; ClickDetector projects its world target and sends real Chrrxs mouse input
only when in range, on-screen, and unoccluded; GuiButton clicks the center of
observed effective bounds through the same real input pipeline. One action can
collect several compatible consequences because watches install first:

```json
{
  "watches": [
    { "id": "triggered", "kind": "signal", "context": "server", "path": "game.Workspace.Door.Prompt", "signal": "Triggered" },
    { "id": "door_changed", "kind": "property_change", "context": "server", "path": "game.Workspace.Door", "property": "Transparency" }
  ],
  "actions": [
    { "id": "prompt_input", "kind": "interaction", "interaction": "proximity_prompt", "path": "game.Workspace.Door.Prompt" }
  ],
  "assertions": [
    { "id": "prompt_fired", "evidence": "triggered", "condition": "at_least_one_occurrence" },
    { "id": "door_reacted", "evidence": "door_changed", "condition": "changed" }
  ]
}
```

Every failed lifecycle/batch/action/assertion/camera/cleanup result preserves
legacy `success`, `failure_kind`, and `error_code` and adds one bounded
`failure` object: category, code, protocol stage, observed-fact summary, last
checkpoint, expected/observed, deadline/elapsed, and retryability
`yes|no|unknown`. Most game readiness failures remain conservative `unknown`:

```json
{
  "category": "readiness", "code": "TOOL_READINESS_TIMEOUT",
  "stage": "Tool prerequisite",
  "summary": "The requested Tool prerequisites did not all become available before the 5000 ms deadline.",
  "last_successful_checkpoint": "harness healthy", "deadline_ms": 5000,
  "retryable": "unknown"
}
```

Batches also have a 1–60 second total `deadline_ms` (30 seconds by default), so
many local prerequisite waits cannot expand execution without bound. Reuse is
explicit and conservative: begin once, run one or a few meaningful batches,
then finish once. The runtime never merges/reorders batches or assumes reused
game state is semantically fresh.

The manager checks Solo status before starting and starts at most one playtest
per session. A wrapper-known compatible caller-owned playtest may be reused but
is never stopped. Successful persistent `roblox_edit`, animation artifact, or
fixture changes advance the wrapper revision and mark active sessions stale.
A stale runtime-owned session can be refreshed once with `refresh_stale=true`;
a caller-owned session is refused. Changes made directly in Studio outside the
wrapper are not guaranteed to advance this revision, so the runtime does not
claim complete external-edit detection.

The fixed harness lives only in each live runtime DataModel, carries
`RobloxAgentManagedEvidence` and its session ID, contains no caller source, and
removes its connections/samplers after every batch. Final cleanup is idempotent
and refuses unmarked conflicting objects. Marked orphan harnesses can be
removed by a later session, but active connections are not durably recovered
across wrapper process restarts.

### Animation artifacts and runtime previews

Animation definitions use ordered keyframes, pose transforms in studs/degrees,
pose easing, and event markers. Start with `kind="animation"` and
`operation="inspect_rig"` to obtain the target rig's actual animated Parts,
Motor6D/animation joints, hierarchy, and canonical paths. Then use
`operation="create"`; a pose `joint` may use a unique returned name or canonical
path. There are no hardcoded R6/R15 joint tables, and an unknown joint fails
against the caller's authoritative rig rather than creating a substitute.

The runtime caches normalized manifests per Studio instance and target path.
Unchanged rigs avoid repeat full inspection; creation validates a compact
structural fingerprint and automatically invalidates/re-inspects once when the
rig disappears, changes, or a cached canonical target is stale. Normal creation
responses include only resolved targets and cache status. The complete manifest
is returned only by explicit `inspect_rig`.

Artifacts are stored at:

```text
game.ServerStorage.RobloxAgentArtifacts.Animations
```

Artifact creation is the default: `preview="none"` validates and commits the
`KeyframeSequence` in the edit DataModel without starting Solo or invoking any
registration API. Replacement constructs the pending sequence before removing
the prior artifact, so a pre-commit failure preserves the old artifact.

Explicit `preview="register"`, `preview="play"`, or an `observation` request
begins only after the artifact is committed. The live context matrix verified
the non-active `AnimationClipProvider:RegisterAnimationClip` in edit context,
so registration uses that smallest modern path. Playback/observation then
borrows the same managed-runtime owner used by `roblox_test` and loads the
returned Studio-local ID through the server runtime evaluator. The result separates
validation, artifact, registration, playback, observation, and cleanup stages.
Later-stage failure never deletes the committed artifact. Temporary IDs are
playtest-session scoped, `published_animation_id` stays null, and
`deployment_ready` stays false.

For deterministic visual sampling, add one to three `observation.samples`
using `time` or `marker`. One runtime track starts once and frames are captured
chronologically relative to that start as raw MCP images. Tracks and both
preview/evidence harnesses are cleaned on failure. `continue_playback` is
accepted only when a compatible caller-owned playtest can truthfully retain
the track; it is refused for a temporary runtime-owned session.

`operation="acquire_fixture"` explicitly creates a neutral Roblox-native R6 or
R15 model, marks it `RobloxAgentManagedFixture`, and returns its canonical path
and actual manifest. It is a general avatar target for animation or gameplay
tests—not a damage dummy, combat NPC, or feature generator. `cleanup_fixture`
refuses unmarked rigs. Supplying an existing target rig never triggers fixture
substitution; temporary fixtures should be cleaned explicitly.

### Runtime inspection

Hierarchy, name/class search, and selected-property reads accept
`context="edit"` (default), `server`, or a live `client-N`. Runtime reads use
fixed bounded Luau owned by the wrapper; no arbitrary code field is public.
Unsupported runtime mode/search combinations fail rather than falling back to
edit. `roblox_observe mode="state"` uses the same selector and requires an
explicit property list at runtime.

## Task state and telemetry

State and instrumentation live below `ROBLOX_AGENT_RUNTIME_DIR` (default:
`<server cwd>/.runtime`):

```text
.runtime/
  current-task.json
  tasks/<task-id>.json
  logs/model-visible.jsonl
  logs/chrrxs-internal.jsonl
  logs/chrrxs-stderr.log
```

The two JSONL streams separate frontier-model decisions from lower-level
Chrrxs work. Each row records runtime/Chrrxs versions, timestamp, task id,
operation/tool, duration, approximate request/response bytes, and success.
Internal log rows additionally record capture target, cursor reuse/before/after,
and partial failure reason. Bounded optional model-call fields count evidence
session events, playtest ownership transitions, actions/probes/watches,
assertions/failures, samples/truncation, runtime errors, managed cleanup, and
animation stage outcomes. Scripts, property payloads, traces, signals, reports,
and screenshots are not copied into telemetry. Telemetry is never inserted into
normal responses.

Task evidence labels runtime-observed artifacts, lifecycle/log smoke checks,
objective behavior, preview/visual evidence, and managed cleanup separately.
Legacy start/status/stop no longer satisfies a generic behavioral `test`
requirement. Only a passing assertion report maps to `behavioral_test`/`test`.
Failed assertions remain recorded. Manual `record_validation` entries retain
`source="caller"`; compact completion reports distinguish implementation-only,
lifecycle smoke, objective pass/failure, visual evidence, cleanup, and remaining
advisory items. Advisory completion remains allowed, while enforced tasks keep
their registered gates.

## Optional live Studio smoke test

This test is explicit opt-in because it controls the currently open place. It
creates one uniquely named harmless tree under Workspace, modifies and inspects
it, captures a screenshot, starts/stops a solo playtest, and deletes the tree
in `finally` even after failure:

```powershell
$env:ROBLOX_AGENT_LIVE_TEST = '1'
npm run test:live
```

To include animation authoring, provide an existing authoritative test rig. The
test inspects it first and derives a canonical non-root target; optionally name
one of the discovered Parts/joints explicitly:

```powershell
$env:ROBLOX_AGENT_LIVE_RIG = 'game.Workspace.Rig'
$env:ROBLOX_AGENT_LIVE_JOINT = 'RightHand' # optional
npm run test:live
```

The dedicated R15 smoke test uses only the wrapper's public contract to create
a temporary real R15 humanoid through
Roblox's `CreateHumanoidModelFromDescriptionAsync`, verifies natural R15 parts
such as `UpperTorso`, `LowerTorso`, `RightUpperArm`, `RightLowerArm`, and
`RightHand`, authors and synchronously captures a marker preview, verifies a
subsequent manifest cache hit, and deletes the temporary rig/artifacts in
`finally`. It does not open a second direct Chrrxs client:

```powershell
$env:ROBLOX_AGENT_LIVE_R15_TEST = '1'
npm run test:live:r15
Remove-Item Env:ROBLOX_AGENT_LIVE_R15_TEST
```

V2 adds two separate opt-in checks. The first records the four registration
APIs across edit-without-Solo, edit-while-Solo, server runtime, and relevant
client runtime contexts. The second exercises reusable evidence, server/client
probes, watches, a bounded series, Tool input, revision staleness, and forced
cleanup. Both use unique names and `finally` cleanup:

```powershell
$env:ROBLOX_AGENT_LIVE_ANIMATION_MATRIX = '1'
npm run test:live:animation-matrix
Remove-Item Env:ROBLOX_AGENT_LIVE_ANIMATION_MATRIX

$env:ROBLOX_AGENT_LIVE_V2_TEST = '1'
npm run test:live:v2
Remove-Item Env:ROBLOX_AGENT_LIVE_V2_TEST
```

V3 adds one dedicated acceptance script. It uses a unique temporary runtime
directory and marked names, restores the original edit camera in the controlled
capture itself, stops only its owned session, cleans the marked fixture through
the guarded author operation, and removes its persistent test objects in
`finally`. It covers five distant edit views; granular session readiness;
live-relative R15 placement; delayed verified Tool use; Prompt, ClickDetector,
and GuiButton input with watches/assertions; and runtime GUI inspection:

```powershell
$env:ROBLOX_AGENT_LIVE_V3_TEST = '1'
npm run test:live:v3
Remove-Item Env:ROBLOX_AGENT_LIVE_V3_TEST
```

V4 adds a separate disposable-place acceptance script for the compact native
path. It creates one uniquely named marked root through edit Luau, reads it
back, runs one managed scenario with client and server Luau, proves a generic
client-request/server-state integration, captures a client screenshot and
incremental logs, then deletes only its own root. Both guards are required:

```powershell
$env:ROBLOX_AGENT_LIVE_V4_TEST = '1'
$env:ROBLOX_AGENT_LIVE_DISPOSABLE = '1'
npm run test:live:v4
Remove-Item Env:ROBLOX_AGENT_LIVE_V4_TEST
Remove-Item Env:ROBLOX_AGENT_LIVE_DISPOSABLE
```

When no compatible Studio/plugin is connected, it prints `UNVERIFIED` rather
than claiming a pass. A live engine/interaction failure after artifacts were
created remains a real failure and still runs cleanup.

The screenshot step requires Chrrxs' documented EditableImage security setting
and a visible Studio window. Live scripts delete only their uniquely named,
marked state. No live test publishes an asset.

## A/B benchmark procedure

1. Prepare two equivalent copies of the same starting place and restart Studio
   between conditions if practical.
2. Use the baseline configuration for one run and the treatment configuration
   for the other. Keep model, prompt, Chrrxs v3.0.3, place, and intervention
   rules fixed.
3. Give the fireball prompt to Grok. Do not add this repository's internal
   design text to the prompt.
4. For treatment, archive `.runtime/logs` and the task JSON after the run.
5. Compare total wall time; public/internal calls; failures by cause;
   `get_runtime_logs` count/duration and reused cursors; task calls/response
   bytes; screenshot count/image bytes; edit/author execution time;
   synchronized animation captures; remaining model-only coding/quality
   failures; completion; and human interventions. Do not run a paid Cursor/Grok
   benchmark without explicit approval.

Baseline Chrrxs logs and the MCP client's transcript must be used for baseline
metrics because the wrapper is intentionally absent from that condition.

## Validation boundary and limitations

Confirmed by automated tests: clean TypeScript build; flat Cursor-visible
schemas plus strict nested validation; task migration/compact evidence state;
incremental role-aware logs; bounded runtime inspection; artifact-only native
animation compilation; fake-clock evidence/preview scheduling; lifecycle
ownership, staleness, cleanup and input-release logic; deterministic camera
geometry/order/restoration/partial failure and fail-closed routing; granular
readiness, fixed GUI inspection, exact fixture aliases, positioning and generic
interaction dispatch with mocks; real
wrapper-to-pinned-Chrrxs stdio initialization; and six public tools only.

Live Studio editing, animation preview, screenshots, and playtest behavior are
confirmed only when the opt-in live test is run successfully on a connected
Studio session. Chrrxs v3 may downscale oversized screenshots; the wrapper
preserves the returned image and structured dimensions/coordinate metadata,
so consumers must not assume image pixels always match native viewport pixels.
Deferred boundaries include arbitrary code/instrumentation/assertion
expressions, signal payloads, automatic game-state reset, performance/payload
telemetry, semantic gameplay/visual judgment, durable live-session recovery,
multi-client evidence, arbitrary client-N controlled capture, device matrices,
video/camera paths, permanent publishing, and global edit transactions. Multiplayer
continues to expose lifecycle/log behavior only. See `DESIGN.md` for details.

After the 3.0.3 upgrade, `npm audit --omit=dev` reports no known production
dependency vulnerabilities.
