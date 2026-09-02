# roblox-agent-runtime V4 design

## Reliability direction

V4 keeps the runtime deterministic where semantic infrastructure creates
guarantees and restores bounded native Luau where it is the clearest and
cheapest representation. Cursor/Grok still sees exactly six tools and never
chooses a raw Chrrxs tool or arbitrary peer. Edit Luau belongs to `roblox_edit`;
fixed-role server/client-1 Luau belongs to managed `roblox_test` sessions.
Chrrxs remains the pinned transport/Studio bridge at exactly
`@chrrxs/robloxstudio-mcp@3.0.3`.

The preferred flow is edit-mode first: author persistent content, inspect its
structure, capture controlled views, revise/package, and use Play only for
execution-dependent evidence. This is discoverability, not an attempt to infer
whether gameplay testing is necessary.

```text
Cursor / Grok
  -> roblox-agent-runtime (six bounded semantic tools)
    -> Chrrxs 3.0.3 stdio MCP
      -> existing Chrrxs Studio plugin
        -> edit, server, and client DataModels
```

The 2.23.1-to-3.0.3 compatibility mappings remain: `search_files` became
`grep_scripts`, `get_selection` became `selection {action:"get"}`, structured
MCP content is preferred with legacy JSON-text fallback, screenshots retain
upstream image/coordinate metadata, and role-aware runtime logs keep cursors
below the model. The wrapper does not modify the Chrrxs package or plugin.

## Public contract and owners

- `roblox_task` persists optional advisory/enforced research state and consumes
  evidence; it does not execute tests.
- `roblox_inspect` owns bounded edit/runtime reads, minimal GUI facts, and logs.
- `roblox_edit` owns generic ordered persistent Instance/script batches and the
  bounded edit-context Luau fast path.
- `roblox_author` owns authoritative-rig inspection, marked native avatar
  fixtures, persistent animation artifacts, and optional managed previews.
- `roblox_test` owns Solo evidence sessions, readiness/actions, fixed-role
  runtime Luau, probes/watches/series, assertions, lifecycle/log collection,
  and cleanup. Existing Solo and multiplayer lifecycle shapes remain supported.
- `roblox_observe` owns unchanged current screenshots plus transient controlled
  multi-view capture, logs, and point state. It remains the visual surface.

Publication uses explicit compact discovery schemas: root actions, essential
fields, bounds, representative nested shapes, and a few decisive examples.
Handler-side Zod unions remain the authoritative strict contract and reject
unknown or conditionally invalid fields before Studio. The published schema is
intentionally less exhaustive, not less validated. `source` exists only in the
two owned Luau envelopes; there is no arbitrary tool/peer selector, expression
language, predicate, or callback surface.

## Shared managed runtime

`ManagedRuntime` is the single lifecycle owner used by `roblox_test` and
animation preview. A session contains a UUID, optional Studio instance ID,
roles, runtime/caller ownership, wrapper revision, ready/stale/ending/cleaned/
failed state, held input, bounded report history, sample count, log session,
and marked artifact inventory.

V3 adds required-role health and a separate compact runtime-state snapshot.
Play defaults to server/client-1 and Run to server, with an explicit bounded
override. `ready` means every requested fixed harness is healthy; it does not
mean Player, Character, Humanoid/root, Backpack, or Tool is available. The
snapshot reports each fact independently, with canonical paths/positions and a
20-item Tool/equipped cap. Existing-session reuse rechecks revision, required
roles, and harness health and permits one fixed-harness recovery attempt.

Begin checks `solo_playtest status`. It starts once if no compatible known
runtime exists. A playtest begun through the legacy wrapper call can be reused
as caller-owned at the same wrapper revision; an unknown external runtime is
refused because its snapshot/objects cannot be verified. Finish collects logs
before peers stop, releases held input, removes runtime markers/connections,
and stops only a lifecycle record owned by that session. Finish is idempotent.
Wrapper shutdown best-effort finishes active sessions.

The runtime does not persist live connections across process restart. The
Roblox harness marker and session attribute let a later begin remove a stale
marked object. An unmarked name conflict is refused. User objects are never
deleted based only on a name.

### Revision boundary

A counter advances after successful persistent structured edit batches, every
attempted edit Luau call, committed animation artifacts, and fixture
acquisition/cleanup. Ready sessions become
stale. A stale batch returns `TEST_SESSION_STALE` with old/current revisions
unless `refresh_stale=true`; only runtime-owned sessions may stop/restart, and
only once. Persistent edits are not globally blocked. Direct Studio UI/plugin
edits outside this wrapper may not be detected, so this is wrapper-mediated
revision correctness rather than a complete Studio transaction system.

## Evidence engine

The one-call `run_scenario` is the short-task default. It and the reusable
begin/run-batch/finish path call the
same engine and return the same report structure. Reports separate session and
revision, lifecycle transitions/ownership, actions, checkpoint observations,
watches, series, assertions, runtime errors, cleanup, warnings, failure kind,
and error code. Screenshots remain separate MCP image blocks.

Actions remain one evidence engine: wait, condition-specific `wait_for`, Chrrxs
keyboard/mouse, exact verified Tool operations, live-relative Model/BasePart
positioning, primitive-specific ProximityPrompt/ClickDetector/GuiButton input,
fixed-role bounded Luau, and screenshot. Each waits only for its own
prerequisites. A scalar Luau result may feed the existing deterministic
assertions; there is no assertion-expression language. Positioning resolves
the current Character pivot at action time, uses PivotTo/CFrame, verifies
distance/facing, never advances revision, and never relocates a player unless
their Character is the explicit subject. Prompt uses native hold methods;
ClickDetector/GuiButton derive coordinates then use Chrrxs real virtual input.
One action can feed several already-installed watches and assertions.

Every batch has a 1-60 second total deadline in addition to the 10-second
explicit-wait cap. Sessions are deliberately reused only when the caller asks;
batches are not merged, reordered, reset, or assumed independent.

Point probes use a shared path resolver/serializer for exact existence,
selected property, and descendant count with exact optional name/class filters.
Watches are installed before actions:

- descendant added/removed catches short-lived objects and returns bounded
  canonical path/class events;
- signal watch first proves the member is an `RBXScriptSignal`, counts it, and
  records bounded timestamps without payloads;
- property watch uses `GetPropertyChangedSignal` and returns initial/final,
  count, and bounded typed values.

Time series run in fixed runtime tasks using the same property/count/existence
probe. They return monotonic session-relative samples, initial/final values,
requested/actual timing, count, missed/dropped/truncated state, and completion.
Each batch resets all watch connections and series tasks in `finally`; session
finish removes the marked harness itself.

Supported scalar serialization is string (1000-character cap), number, boolean,
nil; Roblox support includes EnumItem, Vector2, Vector3, CFrame, Color3, UDim,
UDim2, BrickColor, and Instance canonical references. Anything else is a small
`{type:"unsupported", roblox_type}` value, never an unbounded `tostring` dump.

Bounds are: 20 actions, a 1-60 second total deadline, 10 seconds cumulative
explicit wait, 8 watches, 4
series, 10 seconds/series, 50-2000 ms interval, 100 samples/series, 500 returned
samples/session, 10 checkpoints/50 probes, 20 assertions, 50 events/watch, 20
retained batch reports, and explicit trimming near 128 KB.

Assertions reference evidence produced by the same batch and support only
equals/not-equals, exists/absent, unchanged/changed, exact/min/max counts,
exact/min/max numeric deltas with explicit tolerance, and zero/at-least-one
occurrence. Missing evidence is `missing_evidence`, not a negative pass.
Unsupported/infrastructure state is distinct from behavioral false. Any failed
action/assertion makes the operation unsuccessful while retaining evidence.

## Runtime evidence harness

The compiler emits fixed runtime-owned Luau with request data JSON-decoded. It
stores bounded state in `_G.__ROBLOX_AGENT_EVIDENCE_V2` and a marked Folder in
the live DataModel's `ReplicatedStorage`. It never inserts a Script into an
edit container and never incorporates caller source. Server and client peers
are explicit; missing required roles are infrastructure failures with bounded
health/recovery facts. Reset disconnects batch watchers/cancels samplers;
cleanup validates both marker and session ID before removing state.

## Transient viewport controller

`ViewportController` is a narrow observation owner injected through the shared
tool context. It never owns a playtest and never calls the persistent-mutation
hook. A per-instance/context mutex serializes controlled camera ownership. The
controller validates routing, snapshots only CameraType/CFrame/Focus/FOV,
derives BasePart/Model center/bounds/pivot, applies deterministic spherical
views with a fixed Luau compiler, waits for bounded RenderStepped evidence,
captures through Chrrxs, and restores in `finally`. Wrapper shutdown
best-effort restores in-flight snapshots.

Chrrxs 3.0.3 automatically sends focus/screenshots to the first connected
client. Controlled edit capture therefore rejects an active client before any
camera mutation; controlled runtime capture supports only client-1. Existing
current screenshots retain upstream compatibility auto-routing. Multi-view
results contain one compact manifest then successful image blocks in request
order. Partial captures retain images and records but are MCP errors; transport
or camera-health loss skips remaining views. Restoration failure overrides
capture success. Six total views and two PNGs bound image payloads.

Target-relative and world-relative conventions are explicit. Azimuth/elevation
presets are deterministic, radius is either caller-supplied or conservatively
fit from bounds/FOV/padding, and overhead uses a stable alternate up vector.
There is no raw CFrame/matrix/source input, camera path animation, video, or
client-N orchestration.

## Minimal GUI facts

`roblox_inspect mode="gui"` reuses the runtime path helpers and a fixed bounded
serializer. It exposes only ordered hierarchy, direct/effective visibility,
LayerCollector enabled state, Active/Interactable/Selectable, bounded text and
image references, absolute bounds, rotation/Z/display order, button identity,
viewport intersection, and truncation. Edit output is labeled static and does
not claim PlayerGui layout authority; client-1 output reads actual runtime
bounds. Screenshots remain the visual authority and the runtime makes no design,
occlusion, responsiveness, or accessibility judgment.

## Animation stages and context

The caller's target rig remains authoritative. `inspect_rig` derives actual
Motor6D/AnimationConstraint topology, animated Parts, canonical aliases, roots,
and fingerprint without R6/R15 tables. Cache entries are per Studio instance
and target path. Unknown poses fail. `RIG_MANIFEST_STALE` invalidates, reinspects,
and retries once; normal calls return compact canonical targets rather than the
whole internal manifest.

Animation work is staged:

1. validate definition and authoritative manifest;
2. build a pending `KeyframeSequence` and commit it in edit context;
3. optionally acquire a managed runtime and register;
4. optionally play one track;
5. optionally capture up to three time/marker frames relative to that start;
6. stop the track and clean preview/runtime harnesses.

Artifact-only `preview="none"` is the default and the artifact compiler contains
no registration call. Replacement keeps the old artifact until the pending
sequence is fully built and parented. Registration/play/observation/cleanup
failure cannot delete a committed artifact.

The V1 edit-context `RegisterActiveAnimationClip` path was invalid because the
engine reports it is Solo-only; merely starting Solo does not change an
`execute_luau target="edit"` call's DataModel. The live matrix showed both
active methods fail in every tested context, while non-active
`AnimationClipProvider:RegisterAnimationClip` and
`KeyframeSequenceProvider:RegisterKeyframeSequence` succeed in edit, edit while
Solo exists, server, and client contexts. V2 therefore chooses the modern
AnimationClipProvider non-active method directly in edit context as the
smallest registration stage. Only playback/observation requires a managed Solo
server, where an `Animation` with that Studio-local ID is loaded and played.

Preview IDs are runtime-session-only and may already be expired after managed
cleanup. No asset is published; `published_animation_id=null` and
`deployment_ready=false`. `continue_playback` is allowed only for compatible
caller-owned Solo state, because an owned temporary playtest must be cleaned.

Fixtures are explicit marked native R6/R15 avatar targets for animation or
generic gameplay tests. V3 publishes `kind="fixture"` acquire/inspect/cleanup
as first-class aliases to that exact implementation and marker contract; the
animation fixture forms remain compatible. Cleanup refuses unmarked rigs. They are not damage
dummies, NPC generators, or a catalog of feature primitives, and caller rigs
are never reconstructed or substituted.

## Task evidence integrity

Evidence has both category and source. Runtime categories distinguish artifact,
preview, visual, lifecycle, behavior, cleanup, and implementation. Manual
`record_validation` remains labeled caller-authored. Start/status/stop is only
lifecycle/log smoke evidence and cannot satisfy generic `test`. A successful
assertion report maps explicitly to `behavioral_test` and `test`; a failed
report remains visible but satisfies neither. Compact completion derives
implementation evidence, lifecycle smoke, objective validated/failed/not-run,
cleanup verification, visual evidence, caller validations, and advisory items.
Advisory tasks may finish incomplete; enforced tasks retain gates. Existing
task JSON lacking evidence fields is migrated on load.

## Telemetry and failure policy

Model-visible and Chrrxs-internal JSONL plus child stderr remain separate.
Optional counters cover session events, staleness/lifecycle transitions,
actions/probes/watches/assertions/failures, samples/truncation, runtime errors,
managed artifacts, and animation stages/context. They never log scripts,
property values, full traces/reports, signal payloads, or image data.

Strict schema, transport, malformed-result, unavailable-role, stale-revision,
unsupported property/signal, behavioral, and cleanup failures are surfaced.
Edit batches remain ordered fail-fast rather than transactional. Partial
evidence carries warnings/truncation instead of being silently presented as
complete.

Failed schema, lifecycle, batch, action, assertion, observation, and cleanup
paths preserve legacy top-level fields and add one canonical bounded failure:
category, stable code, protocol stage, observed-fact summary, last checkpoint,
expected/observed, deadline/elapsed, tri-state retryability, and only
stage-relevant diagnostics. `unknown` is normal for changing game state; `no`
is reserved for deterministic schema/class/capability/ownership refusals, and
`yes` only for known wrapper transitions such as the one allowed stale
owned-session refresh. No causal or retry rule engine is inferred.

V4 deliberately adds no performance, timing, payload, token-proxy, or cumulative
session telemetry. Existing V2 telemetry remains compatible. Task evidence
keeps infrastructure/readiness/setup/interaction distinct; only passing
objective assertions satisfy behavioral validation, and camera screenshots are
visual evidence rather than gameplay proof.

## Deferred boundaries

V4 intentionally excludes raw Chrrxs exposure, arbitrary peer selection,
source instrumentation, debug insertion, variable/function tracing, arbitrary assertion languages,
signal payload capture, automatic state reset, performance/payload telemetry,
subjective visual/gameplay interpretation, durable live-session recovery,
multi-client evidence, arbitrary client-N controlled capture, production
replication validation, Marketplace discovery, GUI/VFX DSLs, device matrices,
accessibility critique, camera paths/video, asset publishing, autonomous game
generation, and a universal edit transaction layer. Visual quality remains the
frontier model's responsibility through raw screenshots.

Automated validation proves compiler/schema/manager behavior with mocks and fake
clocks plus real stdio initialization/list/call behavior against the pinned
Chrrxs subprocess. V3 mocks cover camera geometry/order/partial restoration,
fail-closed routing, GUI bounds serialization, role/player readiness, fixtures,
positioning, native interaction dispatch, deadlines, and structured failures.
Studio registration, engine input, playback, and screenshots
are live-confirmed only when their opt-in tests run successfully against a
connected matching plugin; unavailable Studio is reported as unverified, not a
pass.
