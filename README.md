# roblox-agent-runtime

`roblox-agent-runtime` 0.2.0 is a deterministic research MVP that places a small,
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
  selected properties, scripts, selection, and incremental runtime logs.
- `roblox_edit`: one ordered batch of create/modify/move/rename/delete/script
  operations. Create operations may define an `id`; later operations reference
  it as `$id`.
- `roblox_author`: inspect an authoritative R6, R15, or custom part-based rig,
  explicitly acquire/clean marked test fixtures, then persist and preview a
  native `KeyframeSequence` against that exact rig.
- `roblox_test`: solo or multiplayer lifecycle plus bounded logs/error
  extraction.
- `roblox_observe`: viewport screenshot as real MCP image content, logs, or
  targeted state.

The model never sees Chrrxs' `execute_luau` or its full tool list.

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

### Animation artifacts

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

The sibling `Animation` contains a temporary Studio-local content id returned
by `AnimationClipProvider:RegisterActiveAnimationClip`. Results distinguish
the persistent `artifact_path`, Studio-session `preview_id`, and absent
`published_animation_id`, and return `deployment_ready: false`. V1 does not
publish assets.

For deterministic visual sampling, add one to three `observation.samples`
using `time` or `marker`. Frames are captured chronologically as raw MCP images
with timing metadata. `context="edit"` samples a restarted local track;
`context="playtest"` uses a marked, temporary ReplicatedStorage sequence
harness, runs a bounded solo playtest, and removes the harness without adding
scripts to the deliverable. Tracks are cleaned unless edit sampling explicitly
requests `continue_playback`.

`operation="acquire_fixture"` explicitly creates a neutral Roblox-native R6 or
R15 model, marks it `RobloxAgentManagedFixture`, and returns its canonical path
and actual manifest. `cleanup_fixture` refuses unmarked rigs. Supplying an
existing target rig never triggers fixture substitution.

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
and partial failure reason. Telemetry is never inserted into normal responses.

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

The screenshot step requires Chrrxs' documented EditableImage security setting
and a visible Studio window. The animation artifact is intentionally retained
under `ServerStorage.RobloxAgentArtifacts.Animations` for inspection; V1 never
publishes it.

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
schemas plus strict validation; task migration/compact acknowledgements;
incremental role-aware logs; bounded runtime inspection; native fixture and
animation compilation; fake-clock synchronized sampling; mocked routing; real
wrapper-to-pinned-Chrrxs stdio initialization; and six public tools only.

Live Studio editing, animation preview, screenshots, and playtest behavior are
confirmed only when the opt-in live test is run successfully on a connected
Studio session. Chrrxs v3 may downscale oversized screenshots; the wrapper
preserves the returned image and structured dimensions/coordinate metadata,
so consumers must not assume image pixels always match native viewport pixels.
See `DESIGN.md` for the remaining V1 non-goals.

After the 3.0.3 upgrade, `npm audit --omit=dev` reports no known production
dependency vulnerabilities.
