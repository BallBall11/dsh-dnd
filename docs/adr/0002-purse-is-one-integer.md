# The purse is one integer

A purse is a single integer of copper pieces, never one field per
denomination: three fields always admit intermediate states (`8 gp 0 sp −15
cp` is arithmetically 785 and physically meaningless). Denominations exist
only at the edges — parsed on input, produced for display — and affordability
is judged on the total, so 800 cp can pay a 15 cp cost with no copper pieces
on hand.

## Consequences

Affordability and display formatting live at the edges (tool layer, panel);
the stored state never needs denomination arithmetic, and a negative purse is
a validation finding, never a clamped-away value.
