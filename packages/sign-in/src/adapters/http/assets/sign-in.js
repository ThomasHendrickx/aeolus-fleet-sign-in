/* global document, HTMLFormElement, window, fetch, URLSearchParams, FormData */
/* The form keeps input on refusal, shows busy feedback immediately and follows only the server's registered callback or start-again page. */
const form = document.querySelector('[data-testid="sign-in-form"]');
if (form instanceof HTMLFormElement) {
  const button = form.querySelector('button');
  const feedback = document.querySelector('[data-feedback]');
  const unavailable = document.querySelector('[data-unavailable-notice]');
  let retryAt = Number(button.dataset.retryAt ?? 0);
  const waiting = () => {
    if (Date.now() >= retryAt) { button.disabled = false; button.removeAttribute('data-disabled'); button.removeAttribute('data-retry-at'); }
    else { button.setAttribute('data-disabled', ''); window.setTimeout(waiting, Math.min(retryAt - Date.now(), 1000)); }
  };
  if (retryAt > 0) waiting();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = 'Signing in...';
    button.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/sign-in', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(new FormData(form)) });
      const result = await response.json();
      if (result.kind === 'authorized') { window.location.assign(result.redirect); return; }
      if (result.kind === 'startAgain') { window.location.assign(result.location); return; }
      if (typeof result.notice !== 'string') throw new Error('No notice');
      // The notice markup is the server's own escaped rendering of the approved state.
      feedback.innerHTML = result.notice;
      retryAt = result.retryAt ?? 0;
    } catch {
      feedback.replaceChildren(unavailable.content.cloneNode(true));
    } finally {
      button.textContent = 'Sign in';
      button.removeAttribute('aria-busy');
      if (Date.now() >= retryAt) button.disabled = false;
      else waiting();
    }
  });
}
