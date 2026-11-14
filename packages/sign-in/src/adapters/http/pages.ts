/** The approved sign-in frame is static; request values are escaped and passwords never rendered. */
import { readFile } from 'node:fs/promises';

import { ATTEMPT_WINDOW } from '../../core/sign-in/sign-in.js';

const frame = await readFile(new URL('./assets/sign-in.html', import.meta.url), 'utf8');
export const signInStyles = await readFile(new URL('./assets/sign-in.css', import.meta.url), 'utf8');

const MILLISECONDS_PER_MINUTE = 60_000;
const RETRY_TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const ALERT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-exclamation-point lucide-alert-circle lucide-circle-alert" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg>';
const TIMER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-timer" aria-hidden="true"><line x1="10" x2="14" y1="2" y2="2"></line><line x1="12" x2="15" y1="14" y2="11"></line><circle cx="12" cy="14" r="8"></circle></svg>';

/** The approved console button: full width, touch height on phones, faded while disabled. */
const BUTTON_CLASS = "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent font-medium whitespace-nowrap transition-[background-color,border-color,opacity] duration-(--duration-fast) select-none data-disabled:pointer-events-none data-disabled:not-data-loading:opacity-45 data-loading:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--size-icon) bg-primary text-primary-foreground hover:bg-primary-hover h-(--size-control) px-3 text-body w-full max-sm:h-(--size-control-touch)";

/** A credential refusal as the approved scenes show it: a tone, its icon, a first line and an optional second. */
export interface Notice {
  readonly tone: 'attention' | 'waiting';
  readonly title: string;
  readonly detail?: string;
}

export const wrongCredentialNotice: Notice = { tone: 'attention', title: 'Wrong email or password.' };
export const unavailableNotice: Notice = { tone: 'attention', title: 'Sign-in is unavailable.', detail: 'Try again in a moment.' };

export function pausedNotice(retryAt: number): Notice {
  return { tone: 'waiting', title: `Too many attempts. Try again at ${RETRY_TIME.format(retryAt)}.`, detail: `Sign-in is paused for ${String(ATTEMPT_WINDOW / MILLISECONDS_PER_MINUTE)} minutes.` };
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function noticeHtml(notice: Notice): string {
  const detail = notice.detail === undefined ? '' : `<p>${escapeHtml(notice.detail)}</p>`;
  return `<div class="notice ${notice.tone}" role="alert">${notice.tone === 'waiting' ? TIMER_ICON : ALERT_ICON}<div><p class="font-medium">${escapeHtml(notice.title)}</p>${detail}</div></div>`;
}

export function page(content: string, recovery = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Aeolus</title><link rel="stylesheet" href="/sign-in.css"><script defer src="/sign-in.js"></script></head><body>${frame.replace('{{content}}', content).replace('{{recovery}}', recovery)}</body></html>`;
}

export function credentialPage(input: { flow: string; email?: string; notice?: Notice; retryAt?: number }): string {
  const isWaiting = input.retryAt !== undefined;
  const notice = input.notice === undefined ? '' : noticeHtml(input.notice);
  const field = (name: string) => `<div class="flex flex-col gap-1.5"><label for="${name}" class="text-body font-medium text-foreground">${name === 'email' ? 'Email' : 'Password'}</label><input class="w-full rounded-md border border-input bg-card px-3 text-body text-foreground h-(--size-control) max-sm:h-(--size-control-touch) max-sm:text-input-touch" data-testid="sign-in-${name}" id="${name}" name="${name}" type="${name === 'email' ? 'email' : 'password'}" autocomplete="${name === 'email' ? 'username' : 'current-password'}" ${name === 'email' ? `value="${escapeHtml(input.email ?? '')}" placeholder="you@example.com"` : ''} required></div>`;
  return page(`<div class="flex flex-col gap-5"><div><h1 class="text-heading font-semibold max-sm:text-title-touch">Sign in to Aeolus</h1><p class="text-meta text-muted-foreground mt-1">Use your account on this installation.</p></div><div data-feedback>${notice}</div><template data-unavailable-notice>${noticeHtml(unavailableNotice)}</template><form method="post" action="/sign-in" data-testid="sign-in-form" class="flex flex-col gap-4"><input type="hidden" name="flow" value="${escapeHtml(input.flow)}">${field('email')}${field('password')}<button data-testid="sign-in-submit" data-slot="button" type="submit" class="${escapeHtml(BUTTON_CLASS)}" ${isWaiting ? `data-disabled="" disabled data-retry-at="${String(input.retryAt)}"` : ''}>Sign in</button></form></div>`, 'Forgot your password? Ask the person who runs this installation to reset it on the server.');
}

export function refusalPage(input: { heading: string; text: string; action?: { label: string; href: string; testId: string } }): string {
  const action = input.action === undefined ? '' : `<a class="${escapeHtml(BUTTON_CLASS)}" data-slot="button" data-testid="${escapeHtml(input.action.testId)}" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a>`;
  return page(`<div class="flex flex-col gap-4"><h1 class="text-heading font-semibold max-sm:text-title-touch">${escapeHtml(input.heading)}</h1><p class="text-body text-muted-foreground">${escapeHtml(input.text)}</p>${action}</div>`);
}

/** Design 4.2: an expired, refused or other-browser flow cannot complete; the person starts again at the client. */
export function startAgainPage(restartUrl: string): string {
  return refusalPage({ heading: 'We couldn’t sign you in', text: 'Your sign-in didn’t go through. Sign in again.', action: { label: 'Sign in again', href: restartUrl, testId: 'sign-in-start-again' } });
}

/** Scene 11: a public browser before trusted setup can only try the same sign-in again. */
export function setupRequiredPage(retryUrl: string): string {
  return refusalPage({ heading: 'Sign-in is not ready', text: 'The person who runs this installation must finish setup on the server before you can sign in.', action: { label: 'Try again', href: retryUrl, testId: 'sign-in-try-again' } });
}
