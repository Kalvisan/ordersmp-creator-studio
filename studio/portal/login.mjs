const message = 'Sign-in could not start. Try again in a moment.';

export function bindGoogleLogin(
  document,
  fetchImpl = fetch,
  navigate = (url) => location.assign(url)
) {
  const button = document.getElementById('google-sign-in');
  const error = document.getElementById('sign-in-error');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    error.hidden = true;
    error.textContent = '';
    try {
      const response = await fetchImpl('/api/auth/google/start', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (typeof data.url !== 'string' || data.url.length > 8192)
        throw new Error();
      const url = new URL(data.url);
      if (
        url.origin !== 'https://accounts.google.com' ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== '/o/oauth2/v2/auth'
      )
        throw new Error();
      navigate(url.href);
    } catch {
      error.textContent = message;
      error.hidden = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
  button.disabled = false;
}

if (typeof document !== 'undefined') bindGoogleLogin(document);
