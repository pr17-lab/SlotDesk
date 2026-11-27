import { vi } from 'vitest';

export type Org = {
  id: string;
  name: string;
  role: 'owner' | 'staff';
  bookingSlug?: string | null;
};
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
  source?: 'staff' | 'public';
  createdAt: string;
};

export type Member = {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'staff';
};
// The secret is kept here so a test can open the link the owner got.
export type Invitation = {
  id: string;
  orgId: string;
  // For a link to an organization the signed-in user isn't in yet.
  orgName?: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  token: string;
};

// An online booking as the cancel link shows it, with the link's secret.
export type Managed = {
  token: string;
  businessName: string;
  serviceName: string;
  resourceName: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  status: 'confirmed' | 'cancelled';
  cancelBefore: string;
};

type Data = {
  orgs: Org[];
  resources: Resource[];
  services: Service[];
  windows: Window[];
  bookings: Booking[];
  slots: Slot[];
  members: Member[];
  invitations: Invitation[];
  managed: Managed[];
  // What the public page gets for the bot check; null means it is off.
  turnstileSiteKey: string | null;
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
    members: given.members ?? [],
    invitations: given.invitations ?? [],
    managed: given.managed ?? [],
    turnstileSiteKey:
      given.turnstileSiteKey === undefined
        ? 'test-site-key'
        : given.turnstileSiteKey,
  };
  const calls: {
    method: string;
    path: string;
    body: unknown;
    headers?: Record<string, string>;
  }[] = [];
  const holds = new Map<string, Promise<void>>();
  const failures = new Map<string, { status: number; body: unknown }>();
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });
  const noContent = () => new Response(null, { status: 204 });
  const listed = ({ id, label, createdAt, expiresAt }: Invitation) => ({
    id,
    label,
    createdAt,
    expiresAt,
  });

  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ method, path, body, headers });
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
    const publicMatch =
      /^\/api\/public\/([^/]+)(\/resources\/([^/]+)\/availability|\/bookings)?$/.exec(
        route,
      );
    if (publicMatch) {
      const org = data.orgs.find(
        (o) => o.bookingSlug && o.bookingSlug === publicMatch[1].toLowerCase(),
      );
      if (!org) return reply(404, { error: 'Not found' });
      if (!publicMatch[2]) {
        return reply(200, {
          name: org.name,
          resources: data.resources,
          services: data.services,
          turnstileSiteKey: data.turnstileSiteKey,
        });
      }
      if (publicMatch[3]) {
        const resource = data.resources.find((r) => r.id === publicMatch[3]);
        if (!resource) return reply(404, { error: 'Not found' });
        return reply(200, { timeZone: resource.timeZone, slots: data.slots });
      }
      const service = data.services.find((s) => s.id === body.serviceId);
      const resource = data.resources.find((r) => r.id === body.resourceId);
      if (!service || !resource) return reply(404, { error: 'Not found' });
      const slot = data.slots.find((s) => s.startsAt === body.startsAt);
      const endsAt =
        slot?.endsAt ??
        new Date(
          Date.parse(body.startsAt) + service.durationMinutes * 60000,
        ).toISOString();
      data.bookings.push({
        id: `b${data.bookings.length + 1}`,
        resourceId: resource.id,
        serviceId: service.id,
        startsAt: body.startsAt,
        endsAt,
        status: 'confirmed',
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        source: 'public',
        createdAt: '2099-01-01T00:00:00.000Z',
      });
      data.slots = data.slots.filter((s) => s.startsAt !== body.startsAt);
      return reply(201, {
        startsAt: body.startsAt,
        endsAt,
        serviceName: service.name,
        resourceName: resource.name,
        timeZone: resource.timeZone,
      });
    }

    // Like the server: the 404 once the booking has started, and the 409
    // inside the last 24 hours.
    const manageMatch = /^\/api\/manage\/(lookup|cancel)$/.exec(route);
    if (manageMatch) {
      const found = data.managed.find((m) => m.token === body?.token);
      if (!found || Date.now() >= Date.parse(found.startsAt)) {
        return reply(404, { error: 'Not found' });
      }
      if (manageMatch[1] === 'cancel' && found.status === 'confirmed') {
        if (Date.now() >= Date.parse(found.cancelBefore)) {
          return reply(409, { error: 'Too late to cancel online' });
        }
        found.status = 'cancelled';
      }
      // The secret never comes back; JSON leaves out undefined.
      return reply(200, { ...found, token: undefined });
    }

    const inviteMatch = /^\/api\/invitations\/(lookup|accept|decline)$/.exec(
      route,
    );
    if (inviteMatch) {
      const invitation = data.invitations.find((i) => i.token === body?.token);
      if (!invitation) return reply(404, { error: 'Not found' });
      const orgName =
        invitation.orgName ??
        data.orgs.find((o) => o.id === invitation.orgId)?.name ??
        '';
      if (inviteMatch[1] === 'lookup') {
        return reply(200, { orgName, expiresAt: invitation.expiresAt });
      }
      data.invitations.splice(data.invitations.indexOf(invitation), 1);
      if (inviteMatch[1] === 'decline') return noContent();
      data.orgs.push({ id: invitation.orgId, name: orgName, role: 'staff' });
      return reply(200, { orgId: invitation.orgId, orgName, role: 'staff' });
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

    if (rest === '') {
      if (method === 'PATCH') {
        // Trimmed and lowercased, like the server.
        org.bookingSlug =
          body.bookingSlug === null
            ? null
            : body.bookingSlug.trim().toLowerCase();
      }
      return reply(200, { bookingSlug: null, ...org });
    }
    if (rest === '/members') return reply(200, data.members);
    const memberMatch = /^\/members\/([^/]+)$/.exec(rest);
    if (memberMatch) {
      const index = data.members.findIndex((m) => m.userId === memberMatch[1]);
      if (index === -1) return reply(404, { error: 'Not found' });
      data.members.splice(index, 1);
      return noContent();
    }
    if (rest === '/invitations') {
      const mine = data.invitations.filter((i) => i.orgId === org.id);
      // Newest first, like the server.
      if (method === 'GET') return reply(200, mine.map(listed).reverse());
      const n = data.invitations.length + 1;
      const invitation: Invitation = {
        id: `i${n}`,
        orgId: org.id,
        label: body.label,
        createdAt: '2099-01-01T00:00:00.000Z',
        expiresAt: '2099-01-02T00:00:00.000Z',
        token: `secret${n}`.padEnd(43, 'x'),
      };
      data.invitations.push(invitation);
      return reply(201, { ...listed(invitation), token: invitation.token });
    }
    const invitationMatch = /^\/invitations\/([^/]+)$/.exec(rest);
    if (invitationMatch) {
      const index = data.invitations.findIndex(
        (i) => i.orgId === org.id && i.id === invitationMatch[1],
      );
      if (index === -1) return reply(404, { error: 'Not found' });
      data.invitations.splice(index, 1);
      return noContent();
    }
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
        source: 'staff',
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
