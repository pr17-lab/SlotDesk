// Log-capture helpers shared by database test files that check a secret is
// never logged (moved unchanged from auth.token-logs.test.ts in Step 6b).
import { vi } from 'vitest';
import { logger } from '../../../src/logger.js';

// Turns a captured console/stream/logger argument into searchable text,
// including an Error's message, stack and cause chain (requirement 22).
export function toSearchableText(value: unknown): string {
  if (value instanceof Error) {
    const parts = [value.message, value.stack ?? ''];
    let cause: unknown = (value as { cause?: unknown }).cause;
    let guard = 0;
    while (cause !== undefined && guard < 5) {
      if (cause instanceof Error) {
        parts.push(cause.message, cause.stack ?? '');
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(safeStringify(cause));
        break;
      }
      guard += 1;
    }
    return parts.join('\n');
  }
  if (typeof value === 'string') return value;
  return safeStringify(value);
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) =>
      v instanceof Error ? { message: v.message, stack: v.stack } : v,
    );
  } catch {
    return String(value);
  }
}

// Spies on every console method, both process streams, and the pino logger,
// recording searchable text for each call while still letting real output
// through (so the test run's own reporting is unaffected).
export function installCaptureSpies(captured: string[]): {
  restore: () => void;
} {
  // Restoring spies and forwarding to the ORIGINAL (pre-spy) function is
  // deliberate: it lets this file observe every call without silencing
  // Vitest's own console/stream output while the spies are active.
  const restores: Array<() => void> = [];

  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const method of consoleMethods) {
    const original = console[method].bind(console);
    const spy = vi
      .spyOn(console, method)
      .mockImplementation((...args: unknown[]) => {
        for (const arg of args) captured.push(toSearchableText(arg));
        original(...args);
      });
    restores.push(() => spy.mockRestore());
  }

  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    // `write` is overloaded (chunk, [encoding], [callback]); forwarding a
    // generic argument list to it needs `any` -- there is no practical way
    // to type a pass-through proxy over every overload.
    const spy = vi
      .spyOn(stream, 'write')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((chunk: any, ...rest: any[]) => {
        captured.push(toSearchableText(chunk));
        return original(chunk, ...rest);
      });
    restores.push(() => spy.mockRestore());
  }

  const loggerLevels = [
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
  ] as const;
  const loggerRecord = logger as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  for (const level of loggerLevels) {
    if (typeof loggerRecord[level] !== 'function') continue;
    const spy = vi
      .spyOn(loggerRecord, level)
      .mockImplementation((...args: unknown[]) => {
        for (const arg of args) captured.push(toSearchableText(arg));
      });
    restores.push(() => spy.mockRestore());
  }

  return {
    restore: () => {
      for (const restore of restores) restore();
    },
  };
}
