# Accent theming contract and audit

TinyTrain's accent is a runtime CSS-variable contract in `src/routes/layout.css`. The default values
preserve the existing emerald appearance, but the UI no longer depends on Tailwind's concrete
emerald palette. The Appearance settings picker switches the complete `--theme-*` stack by setting
`data-accent-theme` on the root element, without rewriting individual components.

`src/lib/accent-theme.ts` owns the selectable preset metadata, preference validation, persistence,
cross-tab synchronization, and live application. `src/app.html` restores the saved preset before
the first CSS paint so returning users do not see an emerald flash before their theme appears.

## Available presets

| Preset      | Main accent |
| ----------- | ----------- |
| Emerald     | `#6EE7B7`   |
| Ocean Blue  | `#8AA3C1`   |
| Lavender    | `#C4B5FD`   |
| Rose        | `#FDA4AF`   |
| Amber       | `#FCD34D`   |
| Arctic      | `#67E8F9`   |
| Olive Brown | `#5B543A`   |

Ocean Blue and Olive Brown use the product-specified `#8AA3C1` and `#5B543A` values exactly. Each
preset also defines its own soft/subtle accent values, shadow, tinted dark surface stack, and a
contrasting solid-button foreground. Emerald remains the fallback for missing, invalid, or
unavailable browser storage.

## Theme tokens

| Runtime variable                                     | Tailwind alias    | Purpose                                                                            |
| ---------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `--theme-accent`                                     | `accent`          | Primary buttons, loading bars, selected controls, borders, and translucent tints   |
| `--theme-accent-soft`                                | `accent-soft`     | Eyebrows, icons, and lower-emphasis accent text                                    |
| `--theme-accent-subtle`                              | `accent-subtle`   | High-contrast text on dark tinted surfaces                                         |
| `--theme-accent-shadow`                              | `accent-shadow`   | Accent-colored elevation and glow shadows                                          |
| `--theme-on-accent`                                  | `on-accent`       | Text and icons on the solid accent; this must be chosen independently for contrast |
| `--theme-accent-glow`                                | CSS variable only | The translucent page-level atmospheric tint                                        |
| `--theme-surface-canvas*`                            | CSS variables     | Page canvas and background-gradient stops                                          |
| `--theme-surface-app`                                | `surface-app`     | Main app/login shell and sticky app chrome                                         |
| `--theme-surface-overlay`                            | `surface-overlay` | Day, workout, and exercise picker sheets                                           |
| `--theme-surface-raised`                             | `surface-raised`  | Profile menus, action controls, and drag previews                                  |
| `--theme-surface-menu`                               | `surface-menu`    | Elevated action menus and share-image panels                                       |
| `--theme-surface-dialog`                             | `surface-dialog`  | Session time editor and sticky dialog footer                                       |
| `--theme-surface-soft` / `--theme-surface-line-soft` | CSS variables     | Share-image nested rows and borders                                                |

Alpha variants such as `bg-accent/10`, `border-accent/50`, and `focus:border-accent/60` are derived
from the same runtime color. The surface variables centralize the cool/green-black tint visible in
sheets, menus, modals, app chrome, drag previews, and generated share images. Native form controls
also inherit the current accent through `accent-color`.

The fixed semantic variables are intentionally outside the theme:

- `--semantic-success*` keeps the `Done` pill and completion confirmations green.
- `--semantic-positive*` keeps improved weight/reps/RIR values and positive workout comparisons
  green.
- Warning, destructive, regression, disabled, and neutral colors remain on their existing semantic
  palettes.

## Audited UI inventory

The following inventory records every app surface reviewed in this refactor. An item listed as
accent consumes the global contract; semantic items explicitly do not change with the accent.

### Global shell, install, login, and profile

- `src/routes/layout.css`: global page glow and native form-control accent.
- `src/routes/(app)/+layout.svelte`: authentication loading and retry action; editable session-time
  pill tint, border, text, and icon; share and save-edit actions. The completed-session pill uses
  semantic success.
- `src/routes/login/+page.svelte`: TinyTrain and Cloud sync labels, plus the sign-in action.
- `src/lib/InstallPrompt.svelte`: install-button text, border, hover border, and hover tint.
- `src/lib/features/app/ProfileMenu.svelte`: sync modal border/shadow/badge/progress, background-sync
  toast and spinner, and profile-trigger hover border.
- `src/lib/ui/Icon.svelte`: audited as `currentColor` throughout, so icon wrappers own the theme
  color and no SVG palette migration is needed.

### Home, calendar, and scheduling

- `HomeDashboard.svelte`: calendar hover, loading bar, Open workouts action, and exercises icon.
- `DayOverviewPanel.svelte`: Schedule workout action.
- `HomeSessionCard.svelte`: current/selected-session label and Start action.
- `DayPickerSheet.svelte`: Choose day label, month navigation hovers, selected-day tint/border, and
  today text. Completed dots use the active accent; planned dots remain warning amber.
- `HomeCalendar.svelte`: completed dots use the active accent; planned dots remain warning amber.
- `WorkoutPickerSheet.svelte`: Schedule workout label and workout-row hover border.

### Workouts and exercise library

- `WorkoutsScreen.svelte`: loading bar.
- `WorkoutListView.svelte`: Builder/Your workouts labels, primary actions, name-input focus, and row
  hover borders.
- `WorkoutDetailView.svelte`: Add exercise action, Exercise order label, and drag-preview border.
- `ExercisePickerSheet.svelte`: labels, search/custom-input focus, selected-row border and tint,
  Previously used metadata, queue position/check icon, Bilateral/Unilateral selection, and Add
  selected action. This shared sheet also covers session add/swap and settings merge flows.
- `ExercisesScreen.svelte`: loading, labels and icons, Bilateral/Unilateral selections, history/list
  hovers, input focus, and Create custom exercise action.

### Active and completed sessions

- `SessionExerciseScreen.svelte`: loading, fallback action, and Start session action.
- `SessionExerciseHeader.svelte`: Exercise x / y label.
- `SessionExerciseFooter.svelte`: Next and End session actions.
- `SessionExerciseList.svelte`: Exercises label.
- `SessionOverviewHeader.svelte`: session exercise labels and previous-session hover/label in the
  dormant block.
- `SessionOverviewScreen.svelte`: loading and fallback action; Edit time label; time/duration focus
  borders; selected end-mode tints/borders; and Save time action.
- `SessionSummaryPanel.svelte`: Start/Resume action. Positive comparisons use semantic positive.
- `SessionDragPreview.svelte`: reorder-preview border.
- `session-overview.ts`, `SessionSetFieldInput.svelte`, and `SessionSetTable.svelte`: improved field
  text/borders use semantic positive; regressions remain red.
- `session-share-image.ts`: brand heading and exercise ordinal resolve the active runtime accent for
  each render; its canvas/panel/row/border tints resolve the runtime surface stack; volume and set
  improvements resolve semantic positive independently.

### Settings and data tools

- `SettingsScreen.svelte` and `AccentThemePicker.svelte`: live accent preset selection; Settings,
  Appearance, Database, Merge exercises, and Import icon badges; loading/progress states; selected
  appearance card/check/focus; primary merge/import/upload actions; importer information tint; and
  limb-side selections.
- The formerly separate sky importer palette now uses the global accent, and the Database badge is
  aligned with the other accent icon badges.
- The `+2` appearance preview uses semantic positive. Imported-session confirmation uses semantic
  success. Operational status copy uses accent text because it can describe working, success, or a
  partial sync outcome rather than success alone.

## Fixed brand and platform assets

`src/app.html`, `static/manifest.webmanifest`, `static/app-icon.svg`, `static/app-icon.png`, and
`static/apple-touch-icon.png` use fixed browser/PWA/brand colors. These assets cannot consume
runtime CSS variables and are not part of the selectable in-app accent contract. If install icons
or browser chrome should vary by theme later, they will need generated assets and explicit metadata
updates rather than component-token changes.

## Adding a preset

Add its user-facing metadata to `ACCENT_THEMES`, then add the matching
`:root[data-accent-theme='…']` variable block and preview surface in `layout.css`. Override all
`--theme-*` values together, including the surface stack. Never assume dark text is readable on
every accent; set and test `--theme-on-accent` for the selected color. Keep semantic success and
positive values untouched unless a separate product setting is introduced for them.

`theme-contract.test.ts` verifies that every metadata entry has a matching CSS block, exact main
accent, and WCAG AA contrast for text on the solid accent. `accent-theme.test.ts` protects preset
validation and the product-specified Ocean Blue and Olive Brown values.

QA a new theme against this screen matrix:

1. Login, initial loading, install prompt, and profile sync states.
2. Home, calendar/day selection, schedule workout, and start-session actions.
3. Workout creation, exercise selection, Bilateral/Unilateral controls, and drag previews.
4. Active exercise navigation, session edit time/last-set activity, completion, and the Done pill.
5. Exercise history plus positive and negative set comparisons.
6. Settings appearance selection, every icon badge, merge/import/upload flows, and generated share
   images.
