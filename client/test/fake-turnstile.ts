import { act } from '@testing-library/react';
import { vi } from 'vitest';

type Options = {
  sitekey: string;
  size: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
};

// Stands in for Cloudflare's script: records each widget the page draws and
// lets a test play the visitor passing the check.
export function fakeTurnstile() {
  const widgets: { container: HTMLElement; options: Options }[] = [];
  const removed: string[] = [];
  const turnstile = {
    render: vi.fn((container: HTMLElement, options: Options) => {
      widgets.push({ container, options });
      return `w${widgets.length}`;
    }),
    remove: vi.fn((widgetId: string) => {
      removed.push(widgetId);
    }),
  };
  vi.stubGlobal('turnstile', turnstile);

  return {
    widgets,
    removed,
    // The newest widget answers with a token.
    pass(token = 'token-1') {
      act(() => widgets[widgets.length - 1].options.callback(token));
    },
    // The newest widget's token runs out.
    expire() {
      act(() => widgets[widgets.length - 1].options['expired-callback']());
    },
  };
}
