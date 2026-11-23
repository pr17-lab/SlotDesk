import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only cleans up by itself when Vitest globals are on.
afterEach(cleanup);

// jsdom has no ResizeObserver; Headless UI calls it when a combobox closes.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
