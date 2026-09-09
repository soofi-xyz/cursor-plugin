---
name: figma-to-code
description: "Updating existing frontend code to match Figma designs while preserving business logic and adding responsive design test coverage."
license: Complete terms in LICENSE.txt
---
This skill is for frontend engineers updating **existing code** to match a **Figma design**. It focuses on how to **change the code correctly**, preserve business logic, and lock in regressions with responsive design tests.
## When to Use
- You have a Figma design and need to update existing UI.
- A design update should be implemented in `apps/landing_page` or `apps/payment_portal`.
- You must keep business logic intact while refactoring UI.
## Required Inputs
- The app: `apps/landing_page` or `apps/payment_portal`
- The page/route or component(s) being updated
- Figma link(s) for the exact section(s) if possible
- Confirmation of the correct test lane (`test/design` or `test/browser`)
If the Figma design is missing or stale, **ask the user for a new Figma link**.
## Design Intake Rules
1. Prefer **section-level Figma frames** over full-page frames.
2. If only a full page is available, ask for the specific section frame.
3. If design is ambiguous or outdated, stop and request updated Figma.
## Core Engineering Rules
1. **Preserve existing business logic** (handlers, state, APIs, analytics).
2. **Change structure and styles only** to match Figma.
3. **Match breakpoints explicitly** (don’t assume fluid scaling).
4. **Use local component structure**; do not rewrite to a new pattern unless required by design.
## Step-by-Step Coding Workflow
### 1) Locate the implementation
- Find the route/page and the components that render the affected section.
- Identify which SCSS/CSS modules or stylesheets control layout.
### 2) Map Figma to code
- Extract spacing, typography, sizing, layout, text/fill/border/icon colors,
  decoration geometry, and every represented control state from Figma.
- Record action-to-variant mappings by stable action identity or label. Do not
  infer primary/secondary styling from action semantics or DOM order.
- List the mismatches between UI and Figma.
### 3) Update the code (UI only)
- Update markup structure if Figma changes section layout.
- Update SCSS/CSS for spacing, sizes, borders, and typography.
- Add or adjust breakpoint-specific styles for mobile/tablet/desktop.
- Preserve exact variants when moving a section into its final page. Check
  parent selectors, inherited theme values, and browser-native controls for
  drift. A native select indicator is not acceptable when Figma specifies a
  different chevron color; use the existing accessible custom select or a
  custom decorative indicator.
- Do **not** change API calls, state logic, or data flow.
### 4) Commit/override analysis
- Review recent commits/PRs touching this area.
- Check for overrides or regressions:
  - Reverted UI blocks
  - Last-minute CSS overrides
  - Conflicting changes across branches
- If an override caused the bug, restore the intended behavior from the earlier commit.
### 5) QA Bug Log checklist (do not skip)
These frequently missed categories must be verified explicitly:
- Breakpoint-specific widths and max-widths
- Spacing/padding parity across similar boxes
- Border thickness consistency across variants
- Text, icon, fill, and border colors checked separately
- Chevron/caret source, color, size, and position
- Underline/divider width and offsets measured against the intended control
- Named actions retain their exact Figma button variants
- Final-page parent/theme styles do not override isolated component styling
- Typography alignment (size/line-height/weight)
- Nav spacing/logo sizing/label variants on small breakpoints
- Copy changes (strings drift from Figma)
- Scroll position stability between steps
- Missing mobile-specific overrides
Reference: `QA_BUG_LOG.md` and add a new entry when a bug is fixed.
## Testing Guidance (Required)
Follow `skills/responsive-design-tests/SKILL.md` for any design tests:
### Decide test lane
- Use `test/design` for deterministic mocked UI.
- Use `test/browser` when reaching the state requires navigation or live URL.
### Required inputs before writing tests
- app (`apps/landing_page` or `apps/payment_portal`)
- page/route
- Figma link or screenshot
- lane decision: `test/design` or `test/browser`
- navigation steps if real-device
### Run the correct test command
Mocked design spec in `apps/landing_page/test/design`:
```bash
pnpm --dir apps/landing_page exec playwright test --config=playwright.design.config.js test/design/<spec-file>.js --project=chromium
```
Mocked design spec in `apps/payment_portal/test/design`:
```bash
pnpm --dir apps/payment_portal exec playwright test --config=playwright.design.config.js test/design/<spec-file>.js --project=chromium
```
Real-device design browser spec in `apps/landing_page/test/browser`:
```bash
pnpm --dir apps/landing_page run test:e2e -- test/browser/<spec-file>.js
```
BrowserStack real-device design lane:
```bash
pnpm run test:browserstack:landing:design
```
## Output Expectations
- Summary of UI/code changes.
- Files updated and why.
- Commit/override analysis result.
- Tests added or updated.
- Tests run and results.
## Done Checklist
- [ ] I have Figma for the exact section (preferred).
- [ ] Business logic remains unchanged.
- [ ] UI matches Figma across breakpoints.
- [ ] The composed final route matches, not only the isolated component.
- [ ] Icon colors, decoration geometry, and action-to-button variants have
      exact CSS/geometry assertions.
- [ ] QA_BUG_LOG common misses were checked.
- [ ] Commit history checked for overrides.
- [ ] Tests added/updated in the correct lane.
