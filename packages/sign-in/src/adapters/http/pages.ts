/** The approved sign-in frame is static; request values are escaped and passwords never rendered. */
import { readFile } from 'node:fs/promises';

const frame = await readFile(new URL('./assets/sign-in.html', import.meta.url), 'utf8');
export const signInStyles = await readFile(new URL('./assets/sign-in.css', import.meta.url), 'utf8');

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function page(content: string, recovery = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Aeolus</title><link rel="stylesheet" href="/sign-in.css"><script defer src="/sign-in.js"></script></head><body>${frame.replace('{{content}}', content).replace('{{recovery}}', recovery)}</body></html>`;
}

export function credentialPage(input: { flow: string; email?: string; message?: string; retryAt?: number }): string {
  const isWaiting = input.retryAt !== undefined;
  const notice = input.message === undefined ? '' : `<div class="notice ${isWaiting ? 'waiting' : ''}" role="alert"><div>${escapeHtml(input.message)}</div></div>`;
  const field = (name: string) => `<div class="flex flex-col gap-1.5"><label for="${name}" class="text-body font-medium text-foreground">${name === 'email' ? 'Email' : 'Password'}</label><input class="w-full rounded-md border border-input bg-card px-3 text-body text-foreground h-(--size-control) max-sm:h-(--size-control-touch) max-sm:text-input-touch" data-testid="sign-in-${name}" id="${name}" name="${name}" type="${name === 'email' ? 'email' : 'password'}" autocomplete="${name === 'email' ? 'username' : 'current-password'}" ${name === 'email' ? `value="${escapeHtml(input.email ?? '')}" placeholder="you@example.com"` : ''} required></div>`;
  return page(`<div class="flex flex-col gap-5"><div><h1 class="text-heading font-semibold max-sm:text-title-touch">Sign in to Aeolus</h1><p class="text-meta text-muted-foreground mt-1">Use your account on this installation.</p></div><div data-feedback>${notice}</div><form method="post" action="/sign-in" data-testid="sign-in-form" class="flex flex-col gap-4"><input type="hidden" name="flow" value="${escapeHtml(input.flow)}">${field('email')}${field('password')}<button data-testid="sign-in-submit" type="submit" class="w-full rounded-md bg-primary text-primary-foreground font-medium text-body h-(--size-control) max-sm:h-(--size-control-touch)" ${isWaiting ? `disabled data-retry-at="${String(input.retryAt)}"` : ''}>Sign in</button></form></div>`, 'Forgot your password? Ask the person who runs this installation to reset it on the server.');
}

/** The approved console button: full width, touch height on phones, faded while disabled. */
export const BUTTON_CLASS = "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent font-medium whitespace-nowrap transition-[background-color,border-color,opacity] duration-(--duration-fast) select-none data-disabled:pointer-events-none data-disabled:not-data-loading:opacity-45 data-loading:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--size-icon) bg-primary text-primary-foreground hover:bg-primary-hover h-(--size-control) px-3 text-body w-full max-sm:h-(--size-control-touch)";

export function refusalPage(input: { heading: string; text: string; action?: { label: string; href: string; testId: string } }): string {
  const action = input.action === undefined ? '' : `<a class="${escapeHtml(BUTTON_CLASS)}" data-slot="button" data-testid="${escapeHtml(input.action.testId)}" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a>`;
  return page(`<div class="flex flex-col gap-4"><h1 class="text-heading font-semibold max-sm:text-title-touch">${escapeHtml(input.heading)}</h1><p class="text-body text-muted-foreground">${escapeHtml(input.text)}</p>${action}</div>`);
}

/** Design 4.2: an expired, refused or other-browser flow cannot complete; the person starts again at the client. */
export function startAgainPage(restartUrl: string): string {
  return refusalPage({ heading: 'We couldn’t sign you in', text: 'Your sign-in didn’t go through. Sign in again.', action: { label: 'Sign in again', href: restartUrl, testId: 'sign-in-start-again' } });
}
