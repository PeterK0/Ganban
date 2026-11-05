# Gilt: the style guide

Gilt is Ganban's visual design: deep backgrounds, thin gold linework, Josefin Sans headings and Figtree text. This
is the reference for anyone who builds or restyles a screen, including a new tab ([TAB_SPEC.md](TAB_SPEC.md)).

## Design rules

- **Every theme wears Gilt**, all 8 (Catppuccin Mocha, Macchiato, Frappé, Latte, Dracula, Nord, Tokyo Night,
  Gruvbox). Each theme supplies its own gold from its warm colour. Latte, which is light, gets a darker ochre that
  reads on a light background.
- **Ultrawide: fill the width and add columns.** No fixed maximum widths on pages. Card grids add columns as the
  window widens (`grid-template-columns: repeat(auto-fill, minmax(<n>px, 1fr))`). Running text, such as
  descriptions, comments and markdown, stays at a readable line length (about 72ch) inside its panel.
- **Three resizable panels:** the left sidebar (which can also collapse to icons only), a project's task list and
  the side pane. Drag a handle to resize, double-click it to reset. Widths are remembered per device (`localStorage`
  is allowed for cosmetic preferences, [TAB_SPEC.md](TAB_SPEC.md)).
- **The top bar never overflows.** As the window narrows, it gives up space in order: the active task's title
  truncates, then the counts collapse into one button, then the clock hides.
- **Mobile** is Gilt too, adapted to touch (44px targets).

## The shared parts

Every screen builds from these names.

**Colours.**
- The existing `--color-*` variables and their Tailwind names (`base`, `surface-0`, `text`, `primary` and the
  rest) stay, so untouched screens keep working.
- Gilt adds these variables, each with a Tailwind colour of the same name that takes opacity modifiers like the
  others (`tailwind.config.js` `themed()`):
  - `--color-crust` (`crust`): the darkest layer (top bar, sidebar)
  - `--color-mantle` (`mantle`): the app background
  - `--color-gold` (`gold`): ornaments, deco headings, focus rings
  - `--color-gilt-a` (`gilt-a`): gold at about 30%, for card borders
  - `--color-gilt-b` (`gilt-b`): gold at about 11%, for inner outlines and hover fills
- In Gilt, `primary` is the theme's accent (Catppuccin's mauve, Dracula's purple).

**Type.**
- `font-sans` is Figtree, the body text at 15px.
- `font-deco` is Josefin Sans. The `.g-deco` class sets it uppercase with letter-spacing .24em.
- Both fonts are bundled through `@fontsource` (the app runs offline), never from a CDN.

**Corners.** Tailwind's radius scale maps to Gilt: `rounded-sm` 2px; `rounded`, `rounded-md` and `rounded-lg` 3px;
`rounded-xl` 4px; `rounded-2xl` 5px; `rounded-full` unchanged. Existing classes change shape with no edits.

**Classes** (in `src/styles/gilt.css`, inside `@layer components`, prefixed `g-` so they can't collide). A utility on
the same element wins over them, so `g-field w-64` or `g-flbl !mb-0`-style tweaks work without `!` (keep `!` only where
another component class competes):

| Class | Use |
|---|---|
| `g-card` | a panel with a gold border and an inset outline |
| `g-corners` | adds the four gold corner marks (combine with `g-card`) |
| `g-plain` | a quiet panel without gold |
| `g-inset` | a quiet box on the mantle inside a panel: notes, sub-forms, logs |
| `g-deco` | Josefin uppercase |
| `g-h2` | a centred gold deco heading between two diamonds; `.n` inside for a count |
| `g-ptitle` | a page title |
| `g-subtitle` | a sub-view title under a page's `g-ptitle` (Atlas's Bridge, Models) |
| `g-stitle` | a gold deco title in a strip or panel header |
| `g-flbl` | a field label above a field (block, with its margin) |
| `g-cap` | the same small deco type inline: captions, column heads, group labels |
| `g-rule` | a divider: gold deco text between two hairlines |
| `g-reveal` | a section a disclosure just opened eases in (the task editor's "More details", a `g-rule` button) |
| `g-field` (+ `g-field-sm`) | an input, select or textarea; 40px (32px small) |
| `g-form` | on a container: its one-off inputs carrying Tailwind's `border` get the `g-field` colours and focus |
| `g-tog` + `g-tog-k` (+ `g-tog-grn`), `g-togrow` | a switch (`role="switch" aria-checked`), and a label-left row for it |
| `g-dtab` | an underlined tab; current one `aria-selected="true"` or `g-on` |
| `g-seg` + `g-chip` | filter chips and segmented switches; chosen one `aria-selected`, `aria-pressed` or `g-on` |
| `g-on` | the chosen state (gilt fill, gold text, gilt outline) for any selectable control |
| `g-row` | a list row with a hover fill |
| `g-sel` | the selected row: gilt fill, a gold bar on the left, a gilt outline (any row) |
| `g-frow` | a row with a gilt hairline under it (time entries, files) |
| `g-upd` (+ `g-upd-reply`) | a comment or update row |
| `g-bar` | a toolbar strip: mantle with a gilt hairline under it |
| `g-drop` (+ `g-over`) | a dashed gilt drop zone, lit while dragging over |
| `g-pbar` | a thin progress bar; a `<span>` inside sets the width |
| `g-paper` | white paper in every theme (PDF pages) |
| `g-hit` | grows a small pill's hit area to 32px without changing its look |
| `g-read` | caps running text at 72ch |
| `g-gem` | a diamond marker; colour from `--pc` |
| `g-tile` | a project's initial in a tinted square |
| `g-glint` | the hover sheen (off under `prefers-reduced-motion`) |
| `g-btn` + `g-btn-pri`, `g-btn-gilt`, `g-btn-ghost`, `g-btn-danger`, `g-btn-sm` | buttons |
| `g-danger` | on a `g-card`: a danger zone, for an action that can't be undone (with a `g-btn-danger` in it) |
| `g-iconbtn` | a square icon button |
| `g-lnk` | a text link button |
| `g-st` + `g-st-progress`, `g-st-done`, `g-st-blocked` | task status marks |
| `g-tag` + `g-tag-hi`, `g-tag-red`, `g-tag-warn`, `g-tag-ok`, `g-tag-pri` | pills |
| `g-av` | an initials avatar |
| `g-scrim` | the dim layer behind a modal; it covers the whole window, top bar included |
| `g-modal` | a modal panel (`g-card g-corners` look) |

**Focus.** Fields (`g-field`, and bordered inputs inside `g-form`) turn their border gold and show no ring. Every other
control (buttons, switches, tabs, chips, rows) keeps the global 2px gold ring, offset 2px, from the base layer. Native
checkboxes, radios and sliders take the theme's accent.

**Latte.** ThemeProvider sets `data-theme` on `<html>`. `gilt.css` uses it once, to darken `text-medium`,
`text-warning` and `g-tag-warn` on Latte's pale base. Add a rule there rather than a per-screen fix.

Colour helpers: `.c-pur`, `.c-org`, `.c-cyan`, `.c-pink`, `.c-grn`, `.c-yel`, `.c-teal`, `.c-lav` and `.c-none`
set `--pc` for gems and tiles.

**React parts** (`src/components/gilt/`):
- `<DecoHeading count?>` renders `g-h2`.
- `<Card corners? plain? as?>` renders `g-card`, `g-corners` or `g-plain`.
- `<ResizablePane id side min max defaultWidth collapsible?>` is a panel with a drag handle on its inner edge.
  Double-click resets it. The width is stored under `ganban.pane.<id>`.
- `useResizableWidth(id, opts)` is the hook underneath, for layouts that can't wrap.
- `<Modal onClose title?>` renders a `g-scrim` over the whole window with a `g-modal` on top, closes on Esc and
  traps focus. Use it for any new or restyled modal.
- `PopoverShell bare className={STAT_CELL}` (`HomePopover.tsx`) is a stat in a `g-card grid grid-cols-2
  md:grid-cols-4` stats card that opens a pop-up; `PopoverRow mark=` takes a `g-st` or `g-gem` class.
- The side pane is `<ResizablePane id="side-pane" side="right" min={340} max={900} defaultWidth={420}>`, around
  every side pane (App, Home, Calendar, ProjectView and TaskList).

## How to style a new screen

Reach for these, in this order, before writing any colour or size by hand:

1. **Page.** The page sits on `bg-mantle` in a `ScrollArea`. Give it a `g-ptitle` title, with a small `g-deco` line
   above it for context (a date, a count). A view inside a page takes `g-subtitle`.
2. **Panels.** Use `<Card>` or `g-card` for each section, and add `g-corners` to the one or two that lead the page.
   Use `g-plain` for quiet lists, and `g-inset` for a box inside a panel. Title a section with `<DecoHeading>`
   (`g-h2`); a strip header takes `g-bar` with a `g-stitle`.
3. **Grids.** Card grids use `grid-template-columns: repeat(auto-fill, minmax(<n>px, 1fr))`, with no `max-w-*` on
   the page. Running text takes `g-read`.
4. **Forms.** Use a `g-flbl` label over a `g-field`, or `g-field-sm` in dense rows. Use `g-tog` for on/off,
   `g-seg` with `g-chip` for a choice of a few, and `g-dtab` for sections. Mark the chosen one with
   `aria-selected`, `aria-pressed` or `g-on`, never a hand-made `bg-gilt-b text-gold …` string.
5. **Lists.** Use `g-row` rows (`g-sel` for the selected one) or `g-frow` hairline rows. Mark a task's status
   with `statusMark()` (`taskMarks.ts`), a project with `g-gem`/`g-tile` and `projectColorClass()`
   (`lib/projectColor.ts`), a state with a `g-tag-*` pill, and a person with `g-av`.
6. **Actions.** Use one `g-btn-pri` per view for the main action, `g-btn-ghost` or `g-btn-gilt` for the rest,
   `g-btn-danger` for destructive actions, and `g-iconbtn` and `g-lnk` for small ones. Modals use `<Modal>`, and
   confirmations use `confirmDialog`.
7. **Colour.** Use only theme names (`text`, `subtext-*`, `gold`, `gilt-a/b`, `primary`, `success`/`error`/…) or
   `var(--g-mut)`/`var(--g-fg2)` for muted text. Use no hex values, no `blue`, and no `bg-surface-2` panels.
   Check the screen in Latte.
8. **Mobile.** Use the same classes plus the `gm-` touch variants in `src/mobile/mobile.css` (44px targets, 16px
   fields).

## Checking a screen

- **Three themes:** Mocha, Latte (light) and one of Nord, Gruvbox or Tokyo Night. Gold on Latte must stay readable.
- **Two sizes:** 1440×900 and an ultrawide such as 3440×1440. Nothing overflows sideways, and grids add columns on the
  wide one.
- **Keyboard and accessibility:** focus rings are gold (2px, offset 2px; fields show a gold border instead, see
  Focus above), and targets are at least 32px on desktop and 44px on mobile. Keep `aria-*` attributes as they are.
- **The panel rules** in [TAB_SPEC.md § Rules for the panel](TAB_SPEC.md#rules-for-the-panel) hold for every screen:
  `ScrollArea` for scrolling regions, `confirmDialog`, keys stay on the host.
- **A new shared part:** if a screen needs a pattern the classes above don't cover, add it to
  `src/styles/gilt.css` (prefixed `g-`) or `src/components/gilt/`, and list it here, rather than styling one screen
  by hand.

## Looking at your screens (QA)

- Run a throwaway host with your build: `scripts/qa-host.sh <port>` (add `--build` after a change), then open
  `http://127.0.0.1:<port>/`. It serves a copy of a seeded, fictional database, so you never touch real data, and
  a browser on the same machine counts as the host's owner, so there's no sign-in. [TESTING.md § QA host](TESTING.md#qa-host)
  has the details.
- Switch themes in Settings → Design. For a 1440×900 or ultrawide check, size the browser window, or use your
  browser's device toolbar.
- Look at the screens you changed, in the three themes and two sizes.
