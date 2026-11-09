# Independent Tile Dragging And Alignment Spec

Date: 2026-11-09; neat status verified 2026-11-10 02:44 Asia/Shanghai. Separated-card
regression and isolated native checks pass after correcting eligibility. The
formal process has since restarted from this project after the code change:
PID 25448, started 02:41:27, collector active. This neat did not restart the app.
Mixed-DPI, physical input, and scenario-by-scenario user acceptance remain pending.
Owner: project manager. Implementer requested by the user: `codex-mmx-max`.

## Purpose And Authority

Fix the reported behavior: a Ctrl-dragged tile does not actually auto-align,
distant tiles can jitter, and moving a tile to another monitor can require
repeated attempts. This is desktop interaction work in the renderer and Electron
main process. The shared traffic collector and accounting semantics remain intact.

Read [UI_DESIGN_SPEC.md](../UI_DESIGN_SPEC.md), [AGENTS.md](../AGENTS.md), and
[DRAG_ALIGNMENT_RESEARCH.md](DRAG_ALIGNMENT_RESEARCH.md) first. This spec makes
the current dragging requirements testable; it does not restore the superseded
guides-only behavior. Implementation steps are in
[DRAG_ALIGNMENT_PLAN.md](DRAG_ALIGNMENT_PLAN.md).

## Required Behavior

1. A plain left-button drag from any tile moves all visible tiles by the same
   desktop displacement. Their relative positions stay unchanged; no group snap
   or reordering occurs. Movement starts after the existing 4px click threshold.
2. Ctrl+left drag moves only the tile under the pointer. Ctrl pressed before the
   mouse or after mouse-down must both work, including a group gesture already
   in progress. Rebase the pointer anchor when switching so nothing jumps.
   Once switched to independent dragging, keep that mode until release/cancel;
   releasing Ctrl must not unexpectedly pull the other tiles along.
3. During independent dragging, every other tile's native bounds and DOM
   position/size remain unchanged at every observed step. There must be zero
   geometry-mutating calls to sibling windows, even if final bounds would match.
   Siblings are read-only geometry inputs. Do not pan a shared native parent and
   counter-translate siblings, tighten their bounds, or rewrite their positions.
4. An independently dragged tile really snaps to eligible nearby geometry during
   the gesture. X and Y work independently. Releasing retains the displayed
   snapped position; it must not fall back to the unsnapped pointer coordinate.
5. The entry threshold is 8 desktop logical pixels, inclusive. Candidate edges
   come from visible tile rectangles, excluding the dragged tile. X candidates
   allow a gap of up to 32 DIP between vertical intervals; Y candidates allow
   the same gap between horizontal intervals. Overlap/contact is not required.
   The 32 DIP locality bound is an implementation parameter, not a permanent
   user-approved preference. A distant tile sharing one axis
   must never become a candidate. Never globally reorder or avoid collisions.
6. Support matching leading/trailing edges and adjacent facing edges, with both
   contact and 8 DIP spacing targets. Share the spacing constant with default
   placement so an existing normal gap is not collapsed to zero. Free overlap and arbitrary
   unsnapped placement remain possible; snapping is not mandatory grid placement.
7. Keep a stable snap target per axis. Use 8px to enter and an initial 12px to
   release, measured from the raw pointer-derived rectangle, so dragging away
   always works. The 12px value is an implementation choice to verify, not a
   previously accepted user preference or a claim about the researched projects.
   Hold an eligible current target until release; break new-candidate ties
   deterministically by distance, stable tile identity, then edge type.
8. Show alignment guides for the geometry actually applied. Guides must be
   noninteractive, stay inside the dragged tile's surface where possible, and
   disappear on release/cancel. Do not add a large transparent overlay window.
9. One continuous held gesture must cross to another monitor and back, including
   negative desktop coordinates. Preserve the grab offset and real pointer
   capture. Do not clamp to the starting monitor, a renderer viewport, or an
   artificial shared workspace. Use virtual-desktop DIP for native geometry;
   do not multiply already-logical coordinates by devicePixelRatio.
10. Mouse-up commits only the changed tile, or the changed group for a plain
    drag. Escape, pointer cancellation, capture loss, window destruction, or a
    renderer failure must terminate the gesture and clear capture/guides/timers.
    Cancellation restores only the affected objects to their gesture-start
    positions. A group-to-single transition snapshots the single phase at the
    transition; do not undo already-applied group motion by moving siblings.
11. Dragging must not open history, toggle statistics, or open settings. A click
    without dragging retains all existing button and domain-text actions. Right
    clicking retains the context menu; repeated left/right clicks must not be
    needed to start or release a drag.

## Shared Application And Window Lifecycle

- Use one independent frameless native window per visible tile, with one shared
  main-process controller. Do not make each tile a separate application instance.
- Each tile retains the 180x148 content box, existing typography, themes, header
  gear, statistics row, focus states, and domain-only history entry. Any native
  shadow padding must be fixed and accounted for separately from tile geometry.
- **Every tile's gear opens the same singleton global settings window.** If it
  already exists, show/focus that instance. It manages the complete URL list,
  visibility, theme, language, history retention, and statistics window for all
  tiles. Closing/reopening settings does not create per-tile settings or profiles.
- On startup, show the tile group and keep the singleton settings window hidden;
  any tile gear or the tray settings command opens that same settings window.
- There is one shared configuration, secure credential store, loopback server,
  traffic collector, and SQLite ledger. Adding windows must not add collectors,
  duplicate samples, or independent domain totals. Keep renderer sampling out of
  the formal Electron data path.
- Saving settings reconciles visible tile windows without resetting established
  placement. Hidden domains keep collection/history. All-hidden retains the
  existing empty-state/settings access. Unchecking one URL and saving closes only
  its tile; rechecking restores its saved position. Tray show/hide acts on the
  whole group.
- Language/theme changes reach every existing tile. Per-tile statistics toggles
  remain independent. Serialize layout writes in the main process so one
  renderer cannot overwrite another tile's location with an old shared snapshot.
- Opening history keeps its established 380x306 solid-content presentation and
  preferences. Restore the originating tile's position/size on return; other
  tiles remain available. Do not use an enlarged history rectangle as a snap
  target. Settings remains independently visible and can be reached from any tile.
- Persist versioned absolute tile positions in logical desktop coordinates.
  Migrate the old widget origin plus renderer-relative positions once, preserving
  visible positions and all traffic/configuration data. Restart restoration may
  recover an entirely unreachable tile after monitor removal; active dragging
  must never apply that recovery clamp or move other tiles.
- Validate IPC sender ownership, finite coordinates, active gesture identity,
  and membership. A tile cannot identify an arbitrary sibling as its single-drag
  target; late events from a completed gesture cannot move anything.

## Native Input Regions

Use rounded native window regions for the card plus its 3 DIP shadow edge.
Transparent outer padding and gaps between separated tiles must route native
hit tests to lower windows. CSS pointer events alone cannot prove desktop
pass-through; permanently ignoring the whole tile would break its controls.
History uses its 380x306 rounded panel region while open and restores the card
region on close. Refresh on load, resize, display metric/topology changes, and
cross-display scale changes. Keep group/single drag and tile controls working.

## Acceptance Matrix

| ID | Scenario | Required evidence |
| --- | --- | --- |
| A1 | Ctrl drag far from every neighbor | Only dragged window receives geometry writes; siblings unchanged throughout |
| A2 | Same X hundreds of pixels away in Y, and inverse | No candidate, guide, snap, or sibling write |
| A3 | X-only and Y-only with a 24 DIP gap above/below/left/right, plus dual-axis approach | At <=8px entry the native dragged geometry aligns; the other axis moves freely through multiple acknowledged samples; only the relevant guide shows; release persists it; zero sibling writes |
| A3b | Default 8 DIP spacing; orthogonal gap at 32/33 DIP | Existing default gap remains; inclusive locality boundary admits 32 and rejects 33 |
| A4 | Repeated movement near thresholds and equal candidates | Stable target until >12px release; no alternating targets or stuck grab offset |
| A5 | Plain drag, Ctrl-first, mouse-first, mid-drag Ctrl | Correct affected set; transition has no positional jump; group offsets preserved |
| A6 | One held drag across actual available monitor seam and back | Capture stays active, tile follows, no sibling writes; unavailable topology is skipped explicitly |
| A7 | Negative coordinates and 100/125/150/200% scale fixtures | Logical offsets remain correct without double scaling; simulated fixtures labeled as such |
| A8 | Release, Escape, pointercancel, capture loss, repeated gestures | Correct commit/restore, no leaked capture, stale token, timer, or unintended click |
| A9 | Save/reload/restart and old-layout migration | Stable absolute tile positions, idempotent migration, sibling update not overwritten |
| A10 | Open settings from two different tiles | One settings webContents/native window; complete shared settings; save updates all tiles |
| A11 | Theme/language, visibility, tray, history, collection | Existing workflows retained; one collector/ledger; hidden-domain history preserved |
| A12 | All probe processes | Isolated temp profile, hidden non-topmost windows, hard timeout, cleanup, nonzero on failure |
| A13 | Uncheck/recheck one saved URL | Only its tile closes/restores; saved position and collection remain; siblings do not move |

## Verification Limits And Delivery

Run `npm test`, script syntax checks including inline scripts, and a production-main
hidden Electron probe exercising the real preload, IPC, and Chromium capture.
Test the pure geometry separately from composed gesture/window behavior. Native
call instrumentation may record then delegate; it must not replace movement,
capture, snapping, or handlers with a more favorable test implementation.

The user prohibited computer use and disruptive visible testing. Do not use CUA,
physical mouse injection, visible helper windows, focus stealing, or topmost test
windows. Hidden input is limited to isolated probe web contents. Read-only Win32
hit tests against the normally running formal app are allowed under an instance
lease. Start/restart only after checking process/port state and safety; never
bypass a rejected termination.

Earlier 2026-11-10 hit-region round: `npm test` 175/175, syntax/inline checks passed, hidden production-main
probe 35/35. Formal PID 43452 started from an idle 4174 port and reported enabled,
configured, and collector true. `WindowFromPoint` hit the tile body as NetMeter;
transparent padding, a gap, six sampled old-band coordinates and one below-band control hit lower
windows. This proves sampled native routing, not physical clicks or every app's
buttons. Mixed-DPI, capture loss, compositor frames, physical input, and user
visual acceptance remain pending.

Reopened single-axis correction, 2026-11-10: `npm test` 180/180; normal hidden
probe 39 PASS, zero FAIL/SKIP. Four new separated-card cases await each real IPC
handler and verify three native samples, relevant guide only, zero sibling writes,
and saved release position. X-only/Y-only hidden capture images were inspected.
An intentional `--force-failure` run returned exit 1 after the graceful-quit fix.
Older interpolated paths can coalesce to one native write; their green assertions
are not physical continuous-drag proof, nor is the old no-movement Escape check
full cancellation acceptance. At repair delivery, formal PID 36512 (02:21:41
Asia/Shanghai) predated the correction and was left running because no safe
non-UI quit path was available. At neat readback (2026-11-10 02:44:16), that old
process was absent and 4174 belonged to PID 25448, launched at 02:41:27 with this
project path, after the geometry edit at 02:26:58. Status reported enabled,
configured, and collector true. The earlier deployment-pending item is superseded;
this read-only check did not perform the restart or a physical drag acceptance.
The most recent ignored probe log ends with the deliberate --force-failure
assertion used to test exit 1, not an unexpected functional regression.
