# Independent Tile Dragging Implementation Plan

Date: 2026-11-09; manager verification update: 2026-11-10. Implementer:
`codex-mmx-max`, as explicitly requested.
Status verified at neat, 2026-11-10 02:44 Asia/Shanghai: the overlap-only filter
excluded normally separated cards; eligibility and default-gap corrections passed
failing-then-passing regressions and isolated native checks. Formal PID 25448
started from this project at 02:41:27, after the correction, with collection active.
This neat only read the running state and updated documentation. Mixed-DPI,
physical-input, and scenario-by-scenario user visual acceptance remain pending.

The behavior and acceptance IDs are defined in
[DRAG_ALIGNMENT_SPEC.md](DRAG_ALIGNMENT_SPEC.md). Follow
[UI_DESIGN_SPEC.md](../UI_DESIGN_SPEC.md) for all existing presentation details.
Research rationale and source/license limits are in
[DRAG_ALIGNMENT_RESEARCH.md](DRAG_ALIGNMENT_RESEARCH.md).

## Work Boundaries

- Work in the existing dirty checkout. Preserve all prior modifications,
  including main-process sampling fixes and earlier cross-monitor work. Do not
  reset, stash, overwrite, commit, push, or create another worktree.
- The worker owns implementation and verification code, not shared Markdown.
  Expected edits: `main.mjs`, `preload.cjs`, `index.html`, focused new widget
  modules/tests, `layout.test.mjs`, `drag.test.mjs`, and affected probe scripts.
  Update other existing UI tests only when their old architecture assumptions
  actually change; retain their behavioral assertions. Avoid unrelated server,
  accounting, dependency, visual, and installer changes.
- The manager owns publication of this plan/spec, `UI_DESIGN_SPEC.md`,
  `AGENT_MEMORY.md`, and any necessary README corrections. Report proposed
  documentation changes in the durable handoff; do not edit shared .md files.
- Do not delegate further. Use the installed `codex-mmx-max` backend as launched,
  not another model. Do not inspect credentials, resolved provider configuration,
  or any .ssh directory/file. Do not use computer use or interfere with the desktop.

## P0: Enroll And Establish Evidence [Complete]

1. Load the actual global/project rules and the documents linked above. Use
   Node.js 24+ and the installed coordination command:
   `C:/Users/augmigrow/.agents/skills/neat-sync/scripts/coordination.js`.
2. Run status, register your own fresh worker session, and acquire narrow read
   claims before analysis and write claims before edits. Do not use the manager's
   session ID/epoch. If coordination fails, diagnose within the allowed runtime;
   stop before editing rather than doing unregistered shared writes. The parent
   will release its implementation read claims before launching you.
3. Record the dirty baseline and relevant tests. Trace `shiftOtherMeters`, parent
   panning, `tightenMeterBounds`, resize/move IPC, `renderMeters`, localStorage
   persistence, settings singleton creation, history resizing, and startup/shutdown.
   Existing final-position tests are evidence of the old path, not acceptance.

Exit: known affected entry points, your own claims, no shared-file conflict.

## P1: Pure Geometry And Gesture State [Complete]

1. Add a small pure geometry module using immutable desktop-DIP rectangles.
   Inputs: raw dragged rectangle, visible neighbor snapshots, per-axis locks.
   Outputs: applied rectangle, next locks, applied guide coordinates. Keep the
   8px entry and initial 12px release constants together.
2. Filter by orthogonal interval gap <=32 DIP before comparing eligible
   edges. Exclude self/hidden/history surfaces and far-away same-axis tiles.
   Keep X and Y independent, measure release from raw coordinates, and keep
   deterministic candidates. Include contact and 8 DIP spacing targets. Preserve
   inputs; do not expose neighbor mutations. This supersedes overlap-only eligibility.
3. Define pending/group/single/finished/cancelled transitions with one active
   gesture token. Keep stable start bounds and grab offset. Ctrl may promote a
   group drag to single; rebase at that point without moving siblings. Invalid
   sender, pointer/token mismatch, and late events must be harmless.
4. Add meaningful unit tests for A1-A5, A7-A8: exact boundaries, negative/DIP
   coordinates, ties, detachment, input immutability, affected-object writes,
   cancellation, and no jump at a mode transition. Test outputs/side effects;
   avoid relying solely on source-string matches.

Exit: geometry/state behavior is covered independently of Electron rendering.

## P2: Independent Native Windows And Shared State [Complete]

1. Replace the production single shared widget canvas with a registry keyed by
   stable domain identity, one native tile window each. Keep existing security
   settings, icons, themes, dimensions, and lifetime ownership in one main process.
2. Keep the one collector/server/ledger and one shared global configuration.
   Reuse the existing singleton settings creator. Route any registered tile's
   gear to it; a second gear request focuses the same instance. Settings save,
   language/theme, URL visibility, and tray show/hide reconcile all windows.
3. Establish one main-process authority for absolute layout with versioned
   persistence. Migrate old origin+relative positions idempotently without
   clearing renderer configuration, credentials, history, or cumulative totals.
   Hidden/new/deleted tile reconciliation must not reflow unaffected windows.
4. Retain all-hidden access, context menus, settings overlap avoidance, domain
   history, per-tile statistics toggles, and app shutdown. History enlarges only
   its originating surface and restores it; it must not join snap geometry.

Exit: two real hidden tile windows share settings/data; startup, reconciliation,
and old-layout migration work without full-layout geometry rewrites.

## P3: Connect The Real Drag Path [Complete]

1. Preload exposes only validated tile/gesture operations. Main resolves sender
   to the owned tile and applies the pure geometry/state output. Renderers send
   pointer intent and render feedback; do not run a second competing snap engine.
2. Native geometry uses a consistent DIP cursor source and stable grab offset.
   Verify the correct conversion of renderer input across mixed-DPI displays.
   Native move calls for single mode target exactly one window. Group mode
   applies the same displacement to the snapshot of visible tile windows.
3. Preserve real pointer capture, click threshold, Ctrl ordering, cancellation,
   and click suppression after drag. Repeated mouse-up/cancel is idempotent;
   destruction/reload cannot leave a live gesture or polling timer.
4. Remove or retire the production single-drag use of parent pan plus
   `shiftOtherMeters`, post-drop tightening, monitor/viewport clamps, and stale
   shared `meterPositions` persistence. Do not keep an old active fallback that
   silently reinstates these behaviors in Electron mode.
5. Update `layout.test.mjs` and `drag.test.mjs`: replace superseded no-snap and
   sibling-compensation expectations with real snapping and zero sibling writes.
   Do not delete assertions simply to make the suite green.

Exit: production renderer/preload/main path meets A1-A5 and A8-A11.

## P4: Production Integration And Native Hit Verification [Complete With Limits]

1. Import the real `main.mjs` with an isolated temporary profile and port. Keep
   probe windows hidden, non-topmost, and unfocused, and hold an isolated-instance
   lease until process cleanup.
2. Exercise the production drag path with real Chromium pointer capture. Record
   native writes while delegating to Electron; verify independent X/Y snapping,
   both Ctrl orders, group movement, cancellation, and a held cross-monitor return
   with no sibling writes.
3. Verify history input-region open/close and settings save reconciliation,
   including unchecking/rechecking a domain while preserving layout and collector
   membership. Keep probe deadlines and process-tree cleanup.
4. With a formal-instance lease, confirm the app port/process state before launch.
   Use read-only Win32 `WindowFromPoint` checks on the live tile body, transparent
   padding/gap, and the prior overlay band. Do not move the physical cursor or
   create visible helper windows.
5. Run `npm test`, Electron/module syntax checks, inline compilation, and the
   focused hidden production integration probe. Separate current-display results
   from mixed-DPI and physical/user acceptance.

Verified in the manager review: `npm test` 169/169; focused geometry/gesture/layout
tests 47/47; the isolated hidden production-main Electron probe 23/23, exit 0,
including two real available displays, one held drag across the negative-X seam
and back, zero sibling native writes, real snapping/detachment, singleton shared
settings, save reconciliation, trusted Chromium pointer capture, and hidden,
unfocused, non-topmost test windows. Inline script compilation passed. The
ancillary history timeline probe reported 57/58: its close/reopen zoom check was
timing-dependent and failed in one run; do not report that legacy probe as clean.

Follow-up verified 2026-11-10: `npm test` 175/175; Electron and inline syntax
checks passed; hidden production-main probe 35/35 without skips. Fixed missing
guide nodes, native input regions, and `reconcileTiles()` ignoring visibility.
X-only/Y-only snapping, mouse-first Ctrl through the renderer keyboard handler,
group/cancel, history region changes, checkbox off/on with preserved position
and collection, and held cross-monitor return passed. Mouse input retains real
Chromium capture; the hidden keyboard dispatch is not physical key acceptance.

The formal port had no listener before startup. `scripts/start-app.ps1` started
PID 43452 at 2026-11-10 01:57:01 Asia/Shanghai; 4174 reported enabled, configured,
and collector true. Read-only `WindowFromPoint` checks hit the formal tile body
as NetMeter, transparent padding and the adjacent gap as lower windows, and
six sampled points in the old overlay band and one below-band control as lower windows. No cursor move,
physical click, visible helper, or computer-use tool was used.

Still unverified: mixed-DPI displays, physical clicks/keys, capture-loss recovery,
compositor frames, and user visual acceptance. The native checks establish hit
routing at those coordinates rather than completed clicks in every application.
The ancillary history timeline probe's earlier timing-sensitive failure remains
separate from this change and is not reported as clean.

## P5: Worker Handoff And Manager Review [Complete]

1. Worker session `nm-drag-impl-20261109` submitted handoff
   `handoff_17eaa4f5-8fa5-403f-8cb0-412ee8739744`, released claims and the
   isolated probe lease, and ended. The manager reviewed the sealed handoff and
   re-reviewed after correcting stale snap locks, overlapping default positions,
   and gesture identity validation.
2. The earlier manager publication integrated the worker result and updated the
   UI spec, project memory, README, this plan, and the execution spec. This
   2026-11-10 follow-up reconciles native input regions, saved tile visibility,
   formal startup, and current verification limits. No README change was needed.

## Reopened Single-Axis Follow-Up (2026-11-10)

- Reproduced four regression failures before changing geometry: isolated X/Y
  alignment across a gap, default gap preservation, and native-host commit.
- Changed `drag-geometry.mjs` to admit a bounded 32 DIP orthogonal gap and offer
  8 DIP facing-edge spacing targets; `tile-layout.mjs` shares that gap constant.
- `npm test`: 180/180; related syntax, inline script, and diff checks passed.
  Normal hidden Electron run: 39 PASS, zero FAIL/SKIP. Four new separated-card
  cases await the real IPC handler for each sample, verify three native positions
  and guide states, save the final position, and record zero sibling writes.
- Inspected hidden Electron captures for X-only and Y-only guides. Verified the
  probe returns exit 1 with `--force-failure`; its graceful exit now preserves
  failures. Older multi-step/Escape assertions retain their timing limitations
  and are not proof of physical continuous dragging or cancellation.
- At repair delivery, PID 36512 (02:21:41 Asia/Shanghai) predated the geometry
  edit at 02:26:58 and was not force-stopped. Neat readback at 02:44:16 found
  that process gone and 4174 owned by PID 25448, started at 02:41:27 using the
  project's Electron executable and project argument; enabled/configured/collector
  were true. The previous deployment-pending item is cleared. This neat did not
  initiate the restart, use computer use, or claim physical acceptance.
- Consolidated obsolete shared-canvas attempts and duplicated mechanisms in
  AGENT_MEMORY.md into current decisions, evidence pointers, and open limits.
  Preserved the history-timeline timing gap and distinguished deliberate probe
  failure-exit verification from a functional failure. No business code, Git
  commit/push, visible helper, or probe process was added during neat.

## Release Boundary

The user subsequently authorized safe formal-instance verification. Acquire an
instance lease and confirm process/port state before startup; never bypass a
rejected termination or force-stop a conflicting live instance. The formal port
was idle during the earlier hit-region round, so that version was started and
verified. The current formal process now postdates the correction as recorded
above. Keep physical and
user visual acceptance separate from deployment and read-only native checks.
