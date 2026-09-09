---
title: Figma Visual Fidelity
impact: CRITICAL
tags: figma, frontend, visual-regression, controls, buttons
---

# Figma Visual Fidelity

Use this rule whenever Hoopa implements or changes a Figma-driven frontend.
Treat each visible property and each component state as part of the design
contract. Do not rely on semantic guesses such as "this action should probably
be primary."

## 1. Build an explicit property map

Before editing code, map every affected component from the exact Figma frame:

- component identity, label, and control type
- text color, fill/background, border color, border width, radius, and shadow
- icon or chevron source, size, stroke/fill color, and position
- width, height, padding, gap, alignment, and underline/divider geometry
- typography
- default, selected, hover, focus, disabled, loading, and error states that
  appear in the design
- action identity to visual variant, recorded by label or stable action key
- expected placement and surrounding container on the final route

Use exact Figma values or matching repository tokens. Do not collapse distinct
properties into a generic "looks right" check.

If the supplied frame shows a section but not its final-page placement,
preserve the section's exact variants when embedding it. Do not swap button
colors, promote a secondary option, widen decoration to the parent container,
or inherit a different theme merely because the section became main-page
content. If correct composition requires a visual change not represented in
the design, stop and ask for the intended state.

## 2. Implement controls without browser-default drift

Match the represented control type and all of its parts:

- A Figma dropdown must remain an interactive select/menu, not a static label.
- Native select indicators are browser-controlled and often render black. If
  Figma specifies a colored chevron, use the repository's accessible custom
  select or hide the native indicator with `appearance: none` and render the
  specified decorative icon. Keep the native control accessible.
- Size an underline or divider from the control wrapper or exact Figma
  dimension. Do not apply `width: 100%` against a wider page/form container.
- Map each action to its Figma variant by stable identity. Do not infer button
  hierarchy from action semantics or DOM order.
- Check parent selectors, theme providers, CSS inheritance, and broad rules
  such as `button:first-child` after embedding.

Incorrect:

```css
.cadence-select {
  border-bottom: 1px solid var(--blue);
  width: 100%;
}

.payment-actions button:first-child {
  background: var(--blue);
}
```

Correct:

```css
.cadence-control {
  position: relative;
  width: var(--figma-cadence-width);
}

.cadence-control select {
  appearance: none;
  border-bottom: 1px solid var(--figma-cadence-underline);
}

.cadence-control__chevron {
  color: var(--figma-cadence-icon);
  pointer-events: none;
}

.payment-option {
  background: var(--figma-option-background);
}

.update-plan-action {
  background: var(--figma-update-background);
}
```

The token names are illustrative. Reuse target-repository tokens when their
computed values match Figma.

## 3. Verify the composed final route

Verify the component after it is mounted in the actual page, with the actual
theme and parent containers. An isolated story, component test, or temporary
route is insufficient.

At every applicable breakpoint and state:

1. Inspect computed text, icon, fill, and border colors separately.
2. Measure underline/divider width and offsets against the intended control,
   not only against the viewport.
3. Assert each named action's background, text, and border; confirm the
   primary/secondary mapping did not reverse.
4. Exercise enough interaction to reveal selected, open, hover/focus, and
   disabled states represented by Figma.
5. Capture and review the final-route visual diff. Fix implementation drift;
   never update the baseline merely to accept it.

Add exact CSS and geometry assertions to the existing page design spec. Use
stable action labels or test ids so DOM reordering cannot silently swap
variants. The design gate fails if the final route differs even when the
isolated component matches.

## Done checklist

- [ ] Exact Figma frame and final route were inspected
- [ ] Each control's icon color and decoration geometry match
- [ ] Each action retains its Figma-assigned button variant
- [ ] Parent/theme styles do not alter the embedded section
- [ ] Final-route tests cover relevant breakpoints and states
- [ ] Computed-style, geometry, and visual-diff checks pass
