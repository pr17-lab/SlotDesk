import { vi } from 'vitest';

export type Org = { id: string; name: string; role: 'owner' | 'staff' };
export type Resource = { id: string; name: string; timeZone: string };
export type Service = { id: string; name: string; durationMinutes: number };
export type Window = {
  weekday: number;
  startMinute: number;
  endMinute: number;
};

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
  createdAt: string;
};

type Data = {
  orgs: Org[];
  resources: Resource[];
  services: Service[];
  windows: Window[];
  bookings: Booking[];
  slots: Slot[];
};

const asha = { name: 'Asha', email: 'asha@example.com' };

// Answers by method and path, like the real server, for one organization's
// data. Pass arrays in and change them later to play "someone else added it".
export function fakeApi(given: Partial<Data> = {}) {
  const data: Data = {
    orgs: given.orgs ?? [],
    resources: given.resources ?? [],
    services: given.services ?? [],
    windows: given.windows ?? [],
    bookings: given.bookings ?? [],
    slots: given.slots ?? [],
  };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const holds = new Map<string, Promise<void>>();
  const failures = new Map<string, { status: number; body: unknown }>();
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    // Routes and holds ignore the query string; `calls` keeps it.
    const route = path.split('?')[0];
    await holds.get(`${method} ${route}`);

    const failure = failures.get(`${method} ${route}`);
    if (failure) {
      failures.delete(`${method} ${route}`);
      return reply(failure.status, failure.body);
    }

    if (path === '/api/auth/get-session') {
      return reply(200, { session: {}, user: asha });
    }
    if (route === '/api/orgs') {
      if (method === 'GET') return reply(200, data.orgs);
      const org: Org = { id: 'new1', name: body.name, role: 'owner' };
      data.orgs.push(org);
      return reply(201, org);
    }

    const match = /^\/api\/orgs\/([^/]+)(\/.*)?$/.exec(route);
    const org = data.orgs.find((o) => o.id === match?.[1]);
    if (!match || !org) return reply(404, { error: 'Not found' });
    const rest = match[2] ?? '';

    if (rest === '') return reply(200, org);
    if (rest === '/resources') {
      if (method === 'GET') return reply(200, data.resources);
      const resource = { id: `r${data.resources.length + 1}`, ...body };
      data.resources.push(resource);
      return reply(201, resource);
    }
    if (rest === '/services') {
      if (method === 'GET') return reply(200, data.services);
      const service = { id: `s${data.services.length + 1}`, ...body };
      data.services.push(service);
      return reply(201, service);
    }
    if (rest === '/sample-data') {
      if (data.resources.length > 0 || data.services.length > 0) {
        return reply(409, { error: 'This organization already has data' });
      }
      const resource = {
        id: 'r1',
        name: 'Sample room',
        timeZone: body.timeZone,
      };
      const service = { id: 's1', name: 'Sample visit', durationMinutes: 30 };
      data.resources.push(resource);
      data.services.push(service);
      data.windows = [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMinute: 540,
        endMinute: 1020,
      }));
      return reply(201, { resource, service, windows: data.windows });
    }

    if (rest === '/bookings') {
      if (method === 'GET') return reply(200, data.bookings);
      const service = data.services.find((s) => s.id === body.serviceId);
      const slot = data.slots.find((s) => s.startsAt === body.startsAt);
      const endsAt =
        slot?.endsAt ??
        new Date(
          Date.parse(body.startsAt) + (service?.durationMinutes ?? 30) * 60000,
        ).toISOString();
      const booking: Booking = {
        id: `b${data.bookings.length + 1}`,
        resourceId: body.resourceId,
        serviceId: body.serviceId,
        startsAt: body.startsAt,
        endsAt,
        status: 'confirmed',
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        createdAt: '2099-01-01T00:00:00.000Z',
      };
      data.bookings.push(booking);
      data.slots = data.slots.filter((s) => s.startsAt !== body.startsAt);
      return reply(201, booking);
    }
    const cancelMatch = /^\/bookings\/([^/]+)\/cancel$/.exec(rest);
    if (cancelMatch) {
      const booking = data.bookings.find((b) => b.id === cancelMatch[1]);
      if (!booking) return reply(404, { error: 'Not found' });
      booking.status = 'cancelled';
      return reply(200, booking);
    }

    const resourceMatch =
      /^\/resources\/([^/]+)(\/working-hours|\/availability)?$/.exec(rest);
    const resource = data.resources.find((r) => r.id === resourceMatch?.[1]);
    if (!resourceMatch || !resource) return reply(404, { error: 'Not found' });
    if (!resourceMatch[2]) return reply(200, resource);
    if (resourceMatch[2] === '/availability') {
      return reply(200, { timeZone: resource.timeZone, slots: data.slots });
    }
    if (method === 'PUT') data.windows = body.windows;
    return reply(200, { windows: data.windows });
  });
  vi.stubGlobal('fetch', fetch);

  return {
    data,
    calls,
    // The calls made with one method to one path.
    callsTo: (method: string, path: string) =>
      calls.filter((call) => call.method === method && call.path === path),
    // Makes the next request with this method and path answer with an error.
    failNext(method: string, path: string, status: number, body: unknown) {
      failures.set(`${method} ${path}`, { status, body });
    },
    // Keeps a request waiting until the returned function is called.
    hold(method: string, path: string) {
      let release = () => {};
      holds.set(
        `${method} ${path}`,
        new Promise<void>((resolve) => (release = resolve)),
      );
      return release;
    },
  };
}
