---
name: responsive-design-tests
description: "Writing automated design tests that verify responsive UI changes across mobile, tablet, and desktop breakpoints."
---

# Responsive Design Tests

Use this skill when a Figma-driven UI change needs test coverage that verifies visual design across multiple breakpoints.

Reference patterns:

- Mocked design spec in `test/design`: `skills/responsive-design-tests/reference/frictionlessLandingPage.spec.js`
- Breakpoint design browser spec in `test/browser`: `skills/responsive-design-tests/reference/landingPageBreakpoints.spec.js`

## Goals

- Turn design changes into deterministic Playwright assertions using the correct test lane.
- Put strict Figma breakpoint tests in `test/design` when the page or state should be mocked.
- Put real-device design checks in `test/browser` only when the target state must be reached through the app or validated against a real deployed URL.
- Verify responsive behavior across a breakpoint matrix or device-class matrix instead of one-off viewport checks.
- Prefer CSS and geometry assertions for mocked design tests, and responsive-mode plus overflow assertions for real-device design browser tests.
- Cover every changed design area and its responsive layout behavior.
- Ask for the changed page, design source, and any required navigation steps before writing assertions.
- Run the targeted test in the correct lane before finishing so the result is verified.
- Update existing design specs when a covered page is revised; do not add a parallel spec for the same page.

## Required Inputs

Before writing or updating a test, collect the minimum context needed to aim the work at the correct page.

If the user has not already provided them, ask for:

- the app that changed, such as `apps/landing_page` or `apps/payment_portal`
- the page or route that changed
- the Figma URL, screenshot, or design reference
- whether the user wants to update an existing spec or add a new one
- whether the work should be a mocked design spec in `test/design` or a real-device/browser design spec in `test/browser`
- if the target state is reached through another page, the entry route and the exact steps the designer wants the test to take

Use a structured question when available. Keep the intake short and direct.

Do not start writing assertions until you know which page changed and which design-test pattern applies.

## Figma Intake

When the request comes from Figma:

1. Inspect the Figma design or screenshot first.
2. Identify the changed sections, the breakpoint-specific visual expectations, and whether the target state can be opened directly or must be reached through a workflow.
3. If the target state must be reached through another page, ask the designer or requester for the exact navigation steps before writing the test.
4. Translate those expectations into a breakpoint config object or a device-profile expectation object.
5. If the Figma reference is missing, ask the user for it before guessing.

If a Figma reference is unavailable, fall back to the user's description of the visual change and the existing page implementation.

## Two Supported Patterns

### 1. Mocked design specs in `test/design`

Use this pattern when:

- the page or state can be opened directly
- the page depends on API, account, or other controlled data
- the designer wants strict Figma breakpoint checks with deterministic values

Rules:

- put the spec in `test/design`
- prefer mocked data for determinism whenever the page or state depends on controlled data
- use exact breakpoint configs and strict CSS or geometry assertions when those values are intentional design decisions
- follow `skills/responsive-design-tests/reference/frictionlessLandingPage.spec.js` as the primary mocked pattern

### 2. Real-device design browser specs in `test/browser`

Use this pattern when:

- the designer wants validation against a real deployed URL or BrowserStack preview
- the target state must be reached through another page or workflow
- the value of the test is in checking the real experience rather than a mocked direct-entry state

Rules:

- put the spec in `test/browser`
- do not mock the main app data flow unless the user explicitly asks for a hybrid approach
- require the designer or requester to provide the entry route and the exact steps needed to reach the target state
- use device-class or BrowserStack-project expectations instead of blindly copying exact local breakpoint numbers
- follow `skills/responsive-design-tests/reference/landingPageBreakpoints.spec.js` as the primary browser pattern

## Scope Boundary

Use this skill only for visual and responsive design verification based on Figma updates:

- layout
- breakpoint behavior
- spacing
- typography
- colors, control decoration geometry, and action-to-button-variant mapping
- visibility
- sizing
- alignment
- responsive structure across mobile, tablet, and desktop

Minimal interaction is allowed only when needed to reveal or reach the visual state the designer wants inspected.

Do not use this skill for:

- form submission logic
- validation rules
- redirects
- analytics tracking
- API behavior
- state management logic
- business logic

Those belong in separate behavior-oriented component or browser tests.

## Default Approach

1. Decide the test lane first:
   - mocked `test/design`
   - real-device `test/browser`
2. Find an existing Playwright spec for the same page or feature in that lane.
3. If the page already has design coverage, modify that spec to reflect the new design.
4. Extend the existing spec when possible. Create a new spec only when no reasonable home exists.
4. If the target state depends on controlled data and can be opened directly, default to a mocked spec in `test/design`.
5. If the target state must be reached through another page or validated on a real deployed URL, create a separate design spec in `test/browser` and collect the designer-provided navigation steps first.
6. Convert the Figma design into a breakpoint config object or a device-profile expectation object.
7. Assert only the most important visual design properties for each changed section.
8. Run the targeted test in the correct lane and tighten any flaky selectors or timing.

## Breakpoint Workflow

For each design update:

1. List the affected page sections.
2. If the test is mocked in `test/design`, record breakpoint-specific expectations:
   - visibility
   - padding and margins
   - font size and line height
   - width and height
   - alignment and offsets
   - computed colors, decoration geometry, and each action's visual variant
   - flex direction, wrapping, and ordering
   - visual states revealed by responsive controls such as menus or drawers
3. If the test is a real-device/browser design test in `test/browser`, record device-class expectations:
   - compact versus expanded nav mode
   - section visibility and ordering
   - layout direction changes
   - presence of menus, drawers, or responsive controls
   - no horizontal overflow
   - the minimum route steps needed to reach the visual state
4. Store those expectations in a `breakpoints` array or a device-profile config object.
5. Keep the test body generic and read values from the config.

If a UI action is required, use it only to reveal or reach a visual state that must be inspected. Do not test business behavior in this skill.

Prefer this shape:

```js
const breakpoints = [
  {
    name: 'Mobile',
    viewport: { width: 320, height: 900 },
    hero: {
      titleSize: '32px',
      paddingTop: '24px',
      imageHeight: 220,
    },
  },
  {
    name: 'Tablet',
    viewport: { width: 1024, height: 900 },
    hero: {
      titleSize: '44px',
      paddingTop: '72px',
    },
  },
];
```

## Test Structure Rules

- Put strict mocked design specs in `test/design`.
- Put real-device design browser specs in `test/browser` only when the target state must be reached through the app or validated on a real URL.
- Use `test.describe()` per breakpoint group or a loop over breakpoint objects.
- Use `test.use({ viewport: bp.viewport })` so each mocked breakpoint case is explicit.
- For BrowserStack real-device specs, map BrowserStack projects or device classes instead of forcing synthetic viewports.
- Add deterministic setup in `beforeEach()`:
  - seed local storage or experiments if the UI depends on them
  - `page.goto()`
  - wait for `domcontentloaded`
  - wait for the main section selector
  - wait for fonts with `document.fonts.ready`
- If design assertions are only stable locally, gate them with an environment check and keep them in `test/design`.
- Follow the mocked design reference pattern for:
  - a `runDesignAssertions` flag
  - `test.skip()` for non-local or remote environments
  - an explicit `seedExperiments()` helper when experiments control the layout
- Follow the real-device design browser pattern for:
  - BrowserStack project or device mapping
  - real preview or deployed URL handling
  - tolerant responsive assertions instead of exact local pixel checks
- If the target state must be reached through another page, require the designer or requester to provide the exact steps before writing the test.

## Assertion Priority

Assert these first, in this order:

1. Component visibility by breakpoint.
2. Layout mode: flex direction, wrap, justify, align.
3. No horizontal overflow or obvious clipping.
4. Component visual identity and control details: colors, indicators, and
   underline/divider geometry by stable control/action identity.
6. Section spacing: padding, margin, gap.
7. Typography: font size, line height, weight when important.
8. Element dimensions: width, height, card size, media height.
9. Alignment and placement: shared left edge, right offset, centered gap.
10. Text overflow or single-line behavior when the design depends on it.
11. Minimal UI actions needed to reveal breakpoint-specific visual states, such as opening a mobile menu.

Use the full exact-value priority mainly for mocked `test/design` specs. For real-device `test/browser` design tests, stop at visibility, layout mode, section structure, and overflow unless a tighter value is clearly stable and intentional.

## Bounding Box Rules

Use CSS assertions first:

- `toHaveCSS('padding-left', ...)`
- `toHaveCSS('font-size', ...)`
- Exact color/background/border CSS for each named action/control
- `toBeVisible()` or `toBeHidden()`

Use bounding boxes only when CSS is not enough:

- two elements must share the same left edge
- an element must align to the viewport edge
- card content must stay inside a container
- a control must sit in the center of a gap

Use a small helper:

```js
const ensureBox = async (locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box;
};
```

Use bounding-box equality primarily in mocked `test/design` specs. In real-device BrowserStack tests, avoid tight pixel equality unless the tolerance is clearly justified and stable.

## What To Cover

When the design change is broad, cover every major changed section. For each changed section, include the highest-signal assertions:

- navigation or header
- hero area
- cards, reviews, carousels, or media rails
- content sections with images and text
- split layouts that change direction across breakpoints
- FAQ, footer, and CTA areas

If only one section changed in Figma, focus on that section plus any surrounding layout dependencies it affects.

If the designer needs a state that is reachable only through another page or workflow, ask for the exact entry route and step sequence, then stop asserting once the intended visual state is reached.

Do not expand the test into workflow or business-logic coverage unless the user explicitly asks for a separate behavior test.

## Selector Rules

- Prefer stable class names or semantic locators already used by the page.
- Reuse existing selectors and helpers before inventing new ones.
- Avoid brittle selectors tied to deep DOM nesting.
- If text is used, keep it limited to unique user-facing content.

## Anti-Flake Rules

- Do not rely on arbitrary long waits.
- Use short targeted waits for the section under test.
- Do not make animation timing the core assertion.
- Do not use full-page screenshot testing as the primary design check unless the user explicitly asks for it.
- Avoid asserting values that are not intentional design decisions.
- For mocked `test/design` specs, mock the dependent data instead of waiting on uncontrolled backend state.
- For real-device `test/browser` design tests, do not blindly port exact local pixel values from mocked design specs.
- Do not start a workflow-reached design test unless the designer or requester has provided the route steps needed to reach the target state.
- Do not assert API calls, redirects, validation, or analytics in this skill.

## Run And Verify

Do not stop after writing the test. Run the targeted spec and confirm whether it passes.

Use the command that matches the lane:

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

BrowserStack real-device design lane when the spec is intended for preview URLs:

```bash
pnpm run test:browserstack:landing:design
```

Verification rules:

- run the narrowest relevant spec first
- if the test fails, inspect the failure and fix the selectors, waits, or expected design values
- if the failure is caused by the design or environment, report that clearly
- if the spec is BrowserStack-only, say that clearly and validate it in the BrowserStack lane rather than claiming a local run
- do not claim success unless the targeted test was actually run in the correct lane or the user explicitly asked you not to run it

## Implementation Pattern

Use one of these two patterns.

### Pattern A: mocked design spec in `test/design`

```js
import { test, expect } from '@playwright/test';

const shouldSkip = process.env.MOCK_API !== 'true';

const breakpoints = [
  {
    name: 'Mobile',
    viewport: { width: 320, height: 900 },
    nav: { menuVisible: true, linksVisible: false },
    hero: { titleSize: '32px', paddingTop: '24px' },
  },
  {
    name: 'Desktop',
    viewport: { width: 1440, height: 900 },
    nav: { menuVisible: false, linksVisible: true },
    hero: { titleSize: '44px', paddingTop: '72px' },
  },
];

const ensureBox = async (locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box;
};

const seedExperiments = async (page) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      '_soc_experiments',
      JSON.stringify({ 'Landing Page AB Testing': { SiteA: true, SiteB: false } }),
    );
  });
};

breakpoints.forEach((bp) => {
  test.describe(`Page design - ${bp.name}`, () => {
    test.skip(shouldSkip, 'Set MOCK_API=true for deterministic design assertions.');
    test.use({ viewport: bp.viewport });

    test.beforeEach(async ({ page }) => {
      await seedExperiments(page);
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForSelector('.home-header');
      await page.evaluate(() => document.fonts.ready);
    });

    test('matches design expectations', async ({ page }) => {
      const navLinks = page.locator('.header-links');
      const menuButton = page.locator('.header-menu-button');
      const heroTitle = page.locator('.home-header-title');
      const heroContent = page.locator('.home-header-content');

      await (bp.nav.linksVisible ? expect(navLinks).toBeVisible() : expect(navLinks).toBeHidden());
      await (bp.nav.menuVisible ? expect(menuButton).toBeVisible() : expect(menuButton).toBeHidden());
      await expect(heroTitle).toHaveCSS('font-size', bp.hero.titleSize);
      await expect(heroContent).toHaveCSS('padding-top', bp.hero.paddingTop);

      const heroBox = await ensureBox(heroContent);
      expect(Math.round(heroBox.x)).toBeGreaterThanOrEqual(0);
    });
  });
});
```

### Pattern B: real-device design browser spec in `test/browser`

```js
import { test, expect, devices } from '@playwright/test';

const browserstackRealDevices = [
  { projectName: 'bs-iphone-13', playwrightDeviceName: 'iPhone 13' },
  { projectName: 'bs-pixel-7', playwrightDeviceName: 'Pixel 7' },
];

const isBrowserStackRealMobile = process.env.BROWSERSTACK_REAL_MOBILE === '1';

const getBrowserStackDeviceConfig = (projectName) =>
  browserstackRealDevices.find((device) => device.projectName === projectName);

const seedExperiments = async (context) => {
  await context.addInitScript(() => {
    window.localStorage.setItem(
      '_soc_experiments',
      JSON.stringify({ 'Landing Page AB Testing': { SiteA: true, SiteB: false } }),
    );
  });
};

test.describe('Real-device design browser test', () => {
  test.skip(!isBrowserStackRealMobile, 'Run in BrowserStack real-device lane.');

  test('preserves the required responsive design intent', async ({ page }, testInfo) => {
    const deviceConfig = getBrowserStackDeviceConfig(testInfo.project.name);
    test.skip(!deviceConfig, 'Project is not mapped to a design device.');

    const expectedDevice = devices[deviceConfig.playwrightDeviceName];
    const context = page.context();
    await seedExperiments(context);

    await page.goto(process.env.PREVIEW_URL || process.env.TEST_BASE_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.home-header');
    await page.evaluate(() => document.fonts.ready);

    await expect(page.locator('.home-header')).toBeVisible();
    await expect(page.locator('.header-menu-button')).toBeVisible();
    await expect(page.locator('.header-links')).toBeHidden();
    await expect(page.locator('.home-faq')).toBeVisible();
  });
});
```

## Reference Pattern To Follow

For mocked `test/design` specs, mirror the style used in `skills/responsive-design-tests/reference/frictionlessLandingPage.spec.js`:

- the spec lives in `test/design`
- data-dependent UI is mocked for deterministic assertions
- breakpoint objects hold page-specific expectations
- one shared test body reads from those objects
- `ensureBox()` is used for geometry checks when CSS is not enough
- setup is deterministic before assertions run
- experiments are seeded with `addInitScript()` when the page uses them
- exact layout assertions cover visibility, spacing, typography, sizing, and alignment

For real-device design browser specs, mirror the style used in `skills/responsive-design-tests/reference/landingPageBreakpoints.spec.js`:

- the spec lives in `test/browser`
- the test runs against a real preview or deployed URL
- BrowserStack project names or device profiles are mapped explicitly
- experiments may be seeded when they control layout, but the main page data is not mocked
- assertions stay tolerant and focus on responsive mode, section visibility, layout direction, menus, and overflow
- any interaction is only used to reach or reveal the visual state the designer asked to verify

## Done Checklist

Before finishing, confirm all of these are true:

- [ ] I know which app, page, or route changed.
- [ ] I inspected the Figma reference or explicitly asked the user for it.
- [ ] I decided whether this should be a mocked design spec in `test/design` or a real-device design browser spec in `test/browser`.
- [ ] If this is a mocked design spec, the page or state is deterministic and mocked where needed.
- [ ] If this is a real-device design browser spec, I got the entry route and required navigation steps from the designer or requester.
- [ ] The spec covers every changed design area from the Figma update.
- [ ] Mobile, tablet, and desktop breakpoints are represented when relevant.
- [ ] Expectations live in config objects, not scattered magic numbers in the test body.
- [ ] CSS assertions are used for explicit design values.
- [ ] Bounding-box assertions are only used for geometry and alignment checks.
- [ ] Control decoration and named button variants are asserted on the final route.
- [ ] Selectors are stable and readable.
- [ ] The test waits for fonts and critical content before asserting.
- [ ] The assertions stay visual and responsive only, without behavior or business-logic checks.
- [ ] If this is a real-device design browser test, I relaxed exact pixel assertions that are not stable on real devices.
- [ ] The targeted spec was run in the correct lane and passes, or I clearly reported why it could not be verified.

## Agent Instruction

When asked to implement a Figma design update, first ask which page changed and request the Figma reference if it is missing. Then decide whether the correct solution is:

- a mocked design spec in `test/design`, or
- a separate real-device design browser spec in `test/browser`

If the target state can be opened directly and depends on controlled data, default to a mocked design spec in `test/design`.

If the target state must be reached through another page or validated on a real deployed URL, create a separate real-device design browser spec in `test/browser` and require the designer or requester to provide the exact navigation steps.

Keep this skill limited to visual and breakpoint verification only, and run the targeted test in the correct lane before finishing whenever possible.
