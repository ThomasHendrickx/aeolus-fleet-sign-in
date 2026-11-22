import { describe, expect, it } from 'vitest';

import { createLint, reportsOf } from './support/lint-probe.ts';

// End-to-end and browser tests wait on what the app does, never on a sleep,
// `networkidle` or a raw locator (behaviour-driven-development and
// web-frontend skills).

const probes = {
  browser: 'packages/sign-in/test/rules-probe.browser.test.ts',
  e2e: 'packages/sign-in/test/e2e/rules-probe.ts',
  e2eNamed: 'packages/sign-in/test/rules-probe.e2e.test.ts',
  unit: 'packages/sign-in/src/core/accounts/rules-probe.test.ts',
};
const lint = createLint({ tsconfig: 'tsconfig.json', probes: Object.values(probes) });

const inBrowserTests = [probes.browser, probes.e2e, probes.e2eNamed];

const probeOf = (statement: string) => `export async function probe(page: { getByTestId(id: string): unknown; waitForTimeout(ms: number): Promise<void>; waitForLoadState(state: string): Promise<void>; locator(selector: string): unknown }) {
  ${statement}
}
`;

describe('fixed sleeps in browser tests', () => {
  it.each([
    { label: 'waitForTimeout', statement: 'await page.waitForTimeout(500);' },
    { label: 'a promise around setTimeout', statement: 'await new Promise((resolve) => setTimeout(resolve, 500));' },
    { label: 'a promise around window.setTimeout', statement: 'await new Promise((resolve) => window.setTimeout(resolve, 500));' },
  ])('refuses $label', async ({ statement }) => {
    for (const path of inBrowserTests) {
      expect(reportsOf(await lint(probeOf(statement), path), 'no-restricted-syntax')).toHaveLength(1);
    }
  });
});

describe('networkidle in browser tests', () => {
  it('refuses waiting for networkidle', async () => {
    for (const path of inBrowserTests) {
      expect(reportsOf(await lint(probeOf("await page.waitForLoadState('networkidle');"), path), 'no-restricted-syntax')).toHaveLength(1);
    }
  });

  it('allows waiting for another load state', async () => {
    expect(reportsOf(await lint(probeOf("await page.waitForLoadState('load');"), probes.browser), 'no-restricted-syntax')).toEqual([]);
  });
});

describe('raw locators in browser tests', () => {
  it.each([
    { label: 'a CSS locator', statement: "page.locator('.notice');" },
    { label: 'a test id attribute locator', statement: "page.locator('[data-testid=sign-in-submit]');" },
  ])('refuses $label', async ({ statement }) => {
    for (const path of inBrowserTests) {
      expect(reportsOf(await lint(probeOf(statement), path), 'no-restricted-syntax')).toHaveLength(1);
    }
  });

  it('allows the test id getter', async () => {
    expect(reportsOf(await lint(probeOf("page.getByTestId('sign-in-submit');"), probes.browser), 'no-restricted-syntax')).toEqual([]);
  });
});

describe('outside browser tests', () => {
  it('leaves other tests alone', async () => {
    expect(reportsOf(await lint(probeOf('await page.waitForTimeout(500);'), probes.unit), 'no-restricted-syntax')).toEqual([]);
  });
});
