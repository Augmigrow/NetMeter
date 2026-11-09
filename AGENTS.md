# NetMeter Project Instructions

## UI authority

- Read `UI_DESIGN_SPEC.md` before changing any UI, layout, visual token, or interaction behavior.
- Treat its dimensions, typography, colors, grid-line rules, drag behavior, history presentation, and window independence as the accepted baseline.
- Preserve free per-tile placement and independent X/Y alignment. The 2026-11-09 user revision requires real proximity snapping for the dragged tile; the previous guides-only rule is superseded. Only nearby geometry may be a snap candidate, and siblings must remain unchanged throughout the gesture. Do not move a shared parent window and compensate sibling coordinates during a single-tile drag.
- A plain left-button drag anywhere on a tile moves the whole widget with all tiles; `Ctrl`+drag moves only the tile under the pointer. Never move a single tile on a plain drag and never clamp a single-tile drag to an artificial workspace bound.
- Keep the settings and widget windows independently visible. Opening settings must not hide the widget; overlapping windows must be arranged so both remain available.
- Keep the settings gear in the tile header, mean/peak switching in the statistics row, and history activation limited to the domain text.
- Keep the API key visibility controls and encrypted-storage behavior unless the user explicitly changes those requirements.

## Verification

- For UI changes, run `npm test`, validate inline and Electron script syntax, and inspect the result in the running Electron app.
- If an explicit design change is requested, update both `UI_DESIGN_SPEC.md` and `AGENT_MEMORY.md` in the same change.
