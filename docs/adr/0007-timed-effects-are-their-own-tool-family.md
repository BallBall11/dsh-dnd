# Timed effects are their own tool family

`dnd_effect`, `dnd_concentration` and `dnd_death_save` form a separate
family instead of growing `dnd_track`'s parameter list. A duration is not a
scalar on a character: it belongs to a named effect, several can be live at
once, and the verbs form a state machine — start, tick, end, expire — whose
transitions carry consequences (ending an effect can drop concentration;
breaking concentration forces a save). Ticking is campaign-wide: one round
advances every effect on every combatant, which a character-keyed tool
cannot express without inviting one-call-per-character omission.

## Considered Options

Extending `dnd_track` with effect fields — rejected: `dnd_track` is legible
because each parameter is an independent scalar; effect fields would be
meaningless apart from each other and would still need their own addressing
scheme on top, leaving a wide interface over the same state machine.

## Consequences

Effect state persists across calls in the encounter record and is projected
read-only onto the character view; the Panel never writes it. `dnd_track`
keeps its shape, and a whole-party tick is one call.
