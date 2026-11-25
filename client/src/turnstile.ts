// Cloudflare Turnstile, the bot check on the public booking page. The script
// is added only when a booking dialog opens, so no other page loads it.

type RenderOptions = {
  sitekey: string;
  // The app has no dark theme, so the widget stays light too.
  theme: 'light';
  size: 'normal' | 'compact';
  // We keep the token ourselves instead of in Cloudflare's hidden input.
  'response-field': false;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
};

export type Turnstile = {
  render(container: HTMLElement, options: RenderOptions): string;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading: Promise<Turnstile> | undefined;

export function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error('Turnstile did not start'));
    script.onerror = () => {
      // Forget the failure, so the next dialog tries again.
      loading = undefined;
      script.remove();
      reject(new Error('Turnstile did not load'));
    };
    document.head.append(script);
  });
  return loading;
}
