/// <reference lib="dom" />
/** Approved phone/desktop credential states in a real browser, with no screen redesign. */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createService } from '../src/app.js';
import { createSecrets } from '../src/adapters/crypto/secrets.js';
import { createSigner } from '../src/adapters/crypto/signer.js';
import { approvedNotice, noticeIn } from './support/approved-mockups.js';
import { aSetup, fleetOfMaya } from './support/setup-fixtures.js';
import { memoryIdentity } from './support/memory-identity.js';

const origin = 'https://signin.example.test';
const redirectUri = 'https://console.example.test/sign-in/done';

describe('approved credential screens', () => {
  it.each([375, 1440])('keeps credentials on refusal, shows pending immediately, and completes the initiating browser at %i px', async (width) => {
    // Given Maya's setup and the approved credential page in a secure sibling origin.
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width, height: width < 640 ? 812 : 900 } });
    context.setDefaultTimeout(5000);
    const identity = memoryIdentity();
    const secrets = createSecrets();
    const waiting = Promise.withResolvers<undefined>();
    const { privateKey } = generateKeyPairSync('ed25519');
    const service = createService({ identity, fleet: fleetOfMaya(identity), signer: createSigner({ activeKeyId: 'one', keys: [{ id: 'one', privateKey }] }), now: () => Date.now(), secrets: { ...secrets, verifyPassword: async (input) => { await waiting.promise; return secrets.verifyPassword(input); } }, config: {
      origin, cookieDomain: 'example.test', clients: [{ id: 'console', secret: 'client-fixture', redirectUri }], fleets: [{ id: aSetup().input.fleetId, name: 'workshop', consoleUrl: 'https://console.example.test', gatewayUrl: 'https://bridge.example.test' }],
    } });
    try {
      await service.setup.establish(aSetup().input);
      await context.route(`${origin}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const result = await service.server.inject({ method: z.enum(['GET', 'POST']).parse(request.method()), url: url.pathname + url.search, headers: await request.allHeaders(), ...(request.postData() === null ? {} : { payload: request.postData() ?? '' }) });
        const headers = Object.fromEntries(Object.entries(result.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join('\n') : String(value)]]));
        await route.fulfill({ status: result.statusCode, headers, body: result.body });
      });
      await context.route(`${redirectUri}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Console callback boundary</h1>' }));
      const page = await context.newPage();
      const capture = async (state: string) => {
        const directory = process.env.SIGN_IN_SCREENSHOT_DIR;
        if (directory === undefined) return;
        await mkdir(directory, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(directory, `${width}-${state}.png`), fullPage: true });
      };
      const query = new URLSearchParams({ response_type: 'code', client_id: 'console', redirect_uri: redirectUri, state: 'browser-state', code_challenge: await secrets.digest('verifier'), code_challenge_method: 'S256' });
      await page.goto(`${origin}/oauth/authorize?${query.toString()}`);
      await capture('credentials');

      // When Maya submits a wrong credential, then corrects it after the refusal.
      await page.getByTestId('sign-in-email').fill('maya@example.test');
      await page.getByTestId('sign-in-password').fill('wrong');
      await page.getByTestId('sign-in-submit').click();
      expect(await page.getByRole('button', { name: 'Signing in...' }).isDisabled()).toBe(true);
      await capture('pending');
      waiting.resolve(undefined);
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').innerText()).toBe('Wrong email or password.');
      await capture('wrong-credential');
      expect(await page.getByTestId('sign-in-email').inputValue()).toBe('maya@example.test');
      expect(await page.getByTestId('sign-in-password').inputValue()).toBe('wrong');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByTestId('sign-in-password').fill(aSetup().input.password);
      await page.getByTestId('sign-in-submit').click();
      await page.waitForURL(`${redirectUri}?**`);

      // Then it returns to the exact registered callback with a Secure/HttpOnly shared cookie.
      expect(new URL(page.url()).searchParams.get('state')).toBe('browser-state');
      const shared = (await context.cookies()).find((cookie) => cookie.name === 'aeolus_account_session');
      expect(shared).toMatchObject({ domain: '.example.test', httpOnly: true, secure: true });
      expect(await page.getByRole('heading').innerText()).toBe('Console callback boundary');
    } finally {
      waiting.resolve(undefined);
      await context.close();
      await browser.close();
      await service.server.close();
    }
  }, 30_000);

  it.each(['expired', 'another browser', 'no Origin'] as const)('shows the start-again state, never unavailable, for a flow from %s', async (refusal) => {
    // Given Maya's credential page, a clock and a browser whose flow is refused.
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(5000);
    const identity = memoryIdentity();
    const secrets = createSecrets();
    const clock = { now: Date.now() };
    const { privateKey } = generateKeyPairSync('ed25519');
    const service = createService({ identity, fleet: fleetOfMaya(identity), signer: createSigner({ activeKeyId: 'one', keys: [{ id: 'one', privateKey }] }), now: () => clock.now, secrets, config: {
      origin, cookieDomain: 'example.test', clients: [{ id: 'console', secret: 'client-fixture', redirectUri }], fleets: [{ id: aSetup().input.fleetId, name: 'workshop', consoleUrl: 'https://console.example.test', gatewayUrl: 'https://bridge.example.test' }],
    } });
    try {
      await service.setup.establish(aSetup().input);
      await context.route(`${origin}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const { origin: sentOrigin, ...withoutOrigin } = await request.allHeaders();
        const headers = refusal === 'no Origin' ? withoutOrigin : { ...withoutOrigin, ...(sentOrigin === undefined ? {} : { origin: sentOrigin }) };
        const result = await service.server.inject({ method: z.enum(['GET', 'POST']).parse(request.method()), url: url.pathname + url.search, headers, ...(request.postData() === null ? {} : { payload: request.postData() ?? '' }) });
        const replied = Object.fromEntries(Object.entries(result.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join('\n') : String(value)]]));
        await route.fulfill({ status: result.statusCode, headers: replied, body: result.body });
      });
      const page = await context.newPage();
      const query = new URLSearchParams({ response_type: 'code', client_id: 'console', redirect_uri: redirectUri, state: 'browser-state', code_challenge: await secrets.digest('verifier'), code_challenge_method: 'S256' });
      await page.goto(`${origin}/oauth/authorize?${query.toString()}`);
      if (refusal === 'expired') clock.now += 10 * 60 * 1000;
      if (refusal === 'another browser') await context.clearCookies();

      // When Maya submits her correct credential through the page's script.
      await page.getByTestId('sign-in-email').fill('maya@example.test');
      await page.getByTestId('sign-in-password').fill(aSetup().input.password);
      await page.getByTestId('sign-in-submit').click();

      // Then she is told to start again at the console, not that sign-in is unavailable.
      await page.getByRole('heading', { name: 'We couldn’t sign you in' }).waitFor();
      expect(await page.getByText('Your sign-in didn’t go through. Sign in again.').isVisible()).toBe(true);
      expect(await page.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe('https://console.example.test/');
      expect(await page.getByText('Sign-in is unavailable.').count()).toBe(0);
    } finally {
      await context.close();
      await browser.close();
      await service.server.close();
    }
  }, 30_000);

  it.each([['04-wrong-credential', 1], ['05-too-many-attempts', 5], ['23-credential-unavailable', 1]] as const)('shows the approved %s notice through the page script', async (scene, submissions) => {
    // Given Maya's credential page at server time 14:30, with credential processing that fails in scene 23.
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(5000);
    const identity = memoryIdentity();
    const secrets = createSecrets();
    const { privateKey } = generateKeyPairSync('ed25519');
    const isUnavailable = scene === '23-credential-unavailable';
    const service = createService({ identity, fleet: fleetOfMaya(identity), signer: createSigner({ activeKeyId: 'one', keys: [{ id: 'one', privateKey }] }), now: () => Date.UTC(2026, 10, 14, 14, 30), secrets: { ...secrets, verifyPassword: (input) => isUnavailable ? Promise.reject(new Error('Credential processing failed')) : secrets.verifyPassword(input) }, config: {
      origin, cookieDomain: 'example.test', clients: [{ id: 'console', secret: 'client-fixture', redirectUri }], fleets: [{ id: aSetup().input.fleetId, name: 'workshop', consoleUrl: 'https://console.example.test', gatewayUrl: 'https://bridge.example.test' }],
    } });
    try {
      await service.setup.establish(aSetup().input);
      await context.route(`${origin}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const result = await service.server.inject({ method: z.enum(['GET', 'POST']).parse(request.method()), url: url.pathname + url.search, headers: await request.allHeaders(), ...(request.postData() === null ? {} : { payload: request.postData() ?? '' }) });
        const headers = Object.fromEntries(Object.entries(result.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join('\n') : String(value)]]));
        await route.fulfill({ status: result.statusCode, headers, body: result.body });
      });
      const page = await context.newPage();
      await page.clock.setFixedTime(Date.UTC(2026, 10, 14, 14, 30));
      const query = new URLSearchParams({ response_type: 'code', client_id: 'console', redirect_uri: redirectUri, state: 'browser-state', code_challenge: await secrets.digest('verifier'), code_challenge_method: 'S256' });
      await page.goto(`${origin}/oauth/authorize?${query.toString()}`);

      // When Maya submits a wrong password, five times for the pause.
      await page.getByTestId('sign-in-email').fill('maya@example.test');
      await page.getByTestId('sign-in-password').fill('wrong');
      for (let count = 0; count < submissions; count += 1) {
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.getByRole('button', { name: 'Sign in' }).waitFor();
      }

      // Then the notice is the approved one, and the paused button looks disabled.
      expect(noticeIn(await page.locator('[data-feedback]').innerHTML())).toBe(approvedNotice(scene));
      if (scene === '05-too-many-attempts') {
        expect(await page.getByTestId('sign-in-submit').isDisabled()).toBe(true);
        await expect.poll(() => page.getByTestId('sign-in-submit').evaluate((button) => getComputedStyle(button).opacity)).toBe('0.45');
      }
    } finally {
      await context.close();
      await browser.close();
      await service.server.close();
    }
  }, 30_000);
});
