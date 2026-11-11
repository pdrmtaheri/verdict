<!-- scope: public/index.html and public/app.js: whether a person who cannot tell red from green can read each light's state as text on the page. Does not run a browser; judges from source. -->
# Law
The page says each light's state in words, not only by color.

# Where to look
- `public/app.js`: `frame()` writes the `#state` readout; `paint()` colors the lamps.
- `public/index.html`: the `#state` / `.readout` element and its CSS.

# What counts as a violation
- The readout is missing, empty, or does not name the state (red / yellow / green) of BOTH axes (NS and EW).
- The words can disagree with the lamp colors, or only say something non-state-like (e.g. "active", "go") instead of the color word.
- The text is hidden or visually unreadable: `display:none`, `visibility:hidden`, zero or tiny font, `aria-hidden`, or a text color nearly equal to the background (the readout sits on the white page, `#FFFFFF`).
- The words are only available on hover, in a tooltip, or after a click.

# What passes
A visible text line such as "NS green · EW red", updated every frame from the same controller state that paints the lamps, in a legible size and with reasonable contrast. Note any weakness (for example small 12px muted-grey text) in the report, but do not fail for it unless it is actually hard to read.
