import { vi } from 'vitest';

export type Org = { id: string; name: string; role: 'owner' | 'staff' };
export type Resource = { id: string; name: string; timeZone: string };
export type Service = { id: string; name: string; durationMinutes: number };
export type Window = {
  weekday: number;
  startMinute: number;
  endMinute: number;
};

type Data = {
  orgs: Org[];
  resources: Resource[];
  services: Service[];
  windows: Window[];
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
  };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const holds = new Map<string, Promise<void>>();
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    await holds.get(`${method} ${path}`);

    if (path === '/api/auth/get-session') {
      return reply(200, { session: {}, user: asha });
    }
    if (path === '/api/orgs') {
      if (method === 'GET') return reply(200, data.orgs);
      const org: Org = { id: 'new1', name: body.name, role: 'owner' };
      data.orgs.push(org);
      return reply(201, org);
    }

    const match = /^\/api\/orgs\/([^/]+)(\/.*)?$/.exec(path);
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

    const resourceMatch = /^\/resources\/([^/]+)(\/working-hours)?$/.exec(rest);
    const resource = data.resources.find((r) => r.id === resourceMatch?.[1]);
    if (!resourceMatch || !resource) return reply(404, { error: 'Not found' });
    if (!resourceMatch[2]) return reply(200, resource);
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
