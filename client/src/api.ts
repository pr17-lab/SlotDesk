import type { Params } from 'react-router';

// Calls our own API. The app and the API share one origin, so the browser
// sends the session cookie and the Origin header by itself.

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// General messages. A screen can show its own for a status it knows more
// about, like "This slot was just taken" for a 409 on booking.
const messages: Record<number, string> = {
  400: 'Please check the form and try again',
  401: 'Please sign in',
  404: 'Not found',
  409: 'This conflicts with something that exists',
  429: 'Too many requests, wait a few minutes',
  503: 'Busy, try again',
};

type Options = { method?: string; body?: unknown };

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: options.method,
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server, try again');
  }

  // An empty body (204) reads as null.
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      fieldMessage(data) ?? messages[res.status] ?? 'Something went wrong';
    throw new ApiError(res.status, message);
  }
  return data as T;
}

// Our 400s list each bad field with a message meant for people.
function fieldMessage(data: unknown): string | undefined {
  const details = (data as { details?: { message?: unknown }[] } | null)
    ?.details;
  const message = Array.isArray(details) ? details[0]?.message : undefined;
  return typeof message === 'string' ? message : undefined;
}

export type Org = { id: string; name: string; role: 'owner' | 'staff' };
export type Service = { id: string; name: string; durationMinutes: number };
export type Slot = { startsAt: string; endsAt: string };

export type Booking = {
  id: string;
  resourceId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  status: 'confirmed' | 'cancelled';
  customerName: string;
  customerEmail: string;
};

// An action's expected failures go back to the page as data, so the page's
// loaders still reload. Anything else is a bug and is thrown on.
export function errorToData(error: unknown) {
  if (!(error instanceof ApiError)) throw error;
  return { error: error.message };
}

// The route path guarantees these exist; a missing one means a wrong URL.
export function pathParam(params: Params, name: string) {
  const value = params[name];
  if (!value) throw new ApiError(404, messages[404]);
  return value;
}
