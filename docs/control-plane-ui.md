# Personal workspace UI

The personal workspace uses BB's shared resource status, icon, button, input and
textarea components, plus its existing semantic theme and typography tokens.
The ui-ux-pro-max skill supplies review guidance; BB source remains the visual
reference. No new palette, font family or standalone design system is introduced.

## Structure

- Workflows and automations use a recent-item list beside the selected detail on
  wide screens. On compact screens, selecting an item opens its detail with an
  explicit return action. The selected workflow run remains represented even
  when it is outside the loaded list page; loaded rows are ordered by creation
  time.
- Workflow detail prioritizes status, named agent steps and the result. Provider
  and retry metadata sits in expandable execution details. Source and arguments
  share an authoring panel; saved definitions follow it.
- Agent detail prioritizes purpose, conversation and task actions. Configuration
  remains available in a disclosure. The catalog, tasks and schedule editor use
  the same surface and spacing vocabulary.
- Automation detail puts run history before its editing form. Integrations use
  connection rows and a separate credential configuration panel.
- Status includes text as well as a semantic color. Selected rows retain pressed
  state, keyboard focus remains visible, and form controls keep associated labels.

## Verification

The personal UI interaction tests cover navigation, input, pagination, replay,
cancellation, rejected drafts and removal of cached content after access loss.
The production browser journey also checks the refreshed screens at desktop,
375-pixel portrait, landscape and increased text size, with reduced motion, light
and dark themes. Screenshots are saved when
`BB_CONTROL_PLANE_BROWSER_ARTIFACTS` is supplied.


The delivered increment is recorded in
[phase 89 verification](control-plane-phase-89-verification.json). The final
production-browser Docker composite passes all 63 tasks, including recovery.
