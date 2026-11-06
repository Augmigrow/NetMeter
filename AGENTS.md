# NetMeter Project Instructions

## UI authority

- Read `UI_DESIGN_SPEC.md` before changing any UI, layout, visual token, or interaction behavior.
- Treat its dimensions, typography, colors, grid-line rules, drag behavior, history presentation, and window independence as the accepted baseline.
- Do not replace free per-tile placement with grid ordering or whole-layout snapping. X and Y alignment are independent, with an 8px threshold and guide lines. Alignment guides are hints only: a dropped tile keeps the pointer position, and no neighbouring tile may rewrite it.
- A plain left-button drag anywhere on a tile moves the whole widget with all tiles; `Ctrl`+drag moves only the tile under the pointer. Never move a single tile on a plain drag and never clamp a single-tile drag to an artificial workspace bound.
- Keep the settings and widget windows independently visible. Opening settings must not hide the widget; overlapping windows must be arranged so both remain available.
- Keep the settings gear in the tile header, mean/peak switching in the statistics row, and history activation limited to the domain text.
- Keep the API key visibility controls and encrypted-storage behavior unless the user explicitly changes those requirements.

## Verification

- For UI changes, run `npm test`, validate inline and Electron script syntax, and inspect the result in the running Electron app.
- If an explicit design change is requested, update both `UI_DESIGN_SPEC.md` and `AGENT_MEMORY.md` in the same change.
