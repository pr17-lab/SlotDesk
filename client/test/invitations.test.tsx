import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';
import { fakeApi, type Org } from './fake-api';

const owner: Org = { id: 'o1', name: 'Northside Clinic', role: 'owner' };
const staff: Org = { ...owner, role: 'staff' };
const members = [
  { userId: 'u1', name: 'Asha', email: 'asha@example.com', role: 'owner' },
  { userId: 'u2', name: 'Bob', email: 'bob@example.com', role: 'staff' },
] as const;
const TOKEN = 'k'.repeat(43);
const KEY = 'slotdesk.invite';

function open(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

const card = (title: string) =>
  within(screen.getByRole('region', { name: title }));

beforeEach(() => sessionStorage.clear());

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---- The owner's Staff card ----

it('shows the owner the members, with Remove on staff rows only', async () => {
  fakeApi({ orgs: [owner], members: [...members] });
  open('/orgs/o1');

  const staffCard = within(
    await screen.findByRole('region', { name: 'Staff' }),
  );
  expect(staffCard.getByText('Bob')).toBeTruthy();
  expect(staffCard.getByText('bob@example.com')).toBeTruthy();
  expect(staffCard.getByRole('button', { name: 'Remove Bob' })).toBeTruthy();
  expect(staffCard.queryByRole('button', { name: 'Remove Asha' })).toBeNull();
});

it('shows staff no Staff card and never asks for the invitations', async () => {
  const api = fakeApi({ orgs: [staff], members: [...members] });
  open('/orgs/o1');

  expect(await screen.findByText('No resources yet.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Staff' })).toBeNull();
  expect(api.callsTo('GET', '/api/orgs/o1/invitations')).toEqual([]);
});

it('makes an invite link, shows it once with the secret after #, and lists it', async () => {
  const api = fakeApi({ orgs: [owner], members: [...members] });
  const user = userEvent.setup();
  open('/orgs/o1');

  await screen.findByRole('region', { name: 'Staff' });
  await user.type(
    card('Staff').getByLabelText('Who is it for?'),
    'Priya, front desk',
  );
  await user.click(
    card('Staff').getByRole('button', { name: 'Create invite link' }),
  );

  const field = await card('Staff').findByLabelText('Invite link');
  const link = (field as HTMLInputElement).value;
  expect(link).toBe(
    `${window.location.origin}/invite#${api.data.invitations[0]!.token}`,
  );
  expect((field as HTMLInputElement).readOnly).toBe(true);
  expect(
    card('Staff').getByText(
      "Send this link to them yourself. It works once, for 24 hours. You won't see it again.",
    ),
  ).toBeTruthy();
  expect(api.callsTo('POST', '/api/orgs/o1/invitations')[0]!.body).toEqual({
    label: 'Priya, front desk',
  });
  expect(
    await card('Staff').findByRole('button', {
      name: 'Cancel invite for Priya, front desk',
    }),
  ).toBeTruthy();

  await user.click(card('Staff').getByRole('button', { name: 'Copy link' }));
  expect(await navigator.clipboard.readText()).toBe(link);
  expect(await card('Staff').findByText('Copied')).toBeTruthy();
});

it('says what to do when 20 invites are pending', async () => {
  const api = fakeApi({ orgs: [owner], members: [...members] });
  api.failNext('POST', '/api/orgs/o1/invitations', 409, {
    error: 'Too many pending invitations',
  });
  const user = userEvent.setup();
  open('/orgs/o1');

  await screen.findByRole('region', { name: 'Staff' });
  await user.type(card('Staff').getByLabelText('Who is it for?'), 'Priya');
  await user.click(
    card('Staff').getByRole('button', { name: 'Create invite link' }),
  );

  expect((await card('Staff').findByRole('alert')).textContent).toBe(
    'You have 20 invites waiting. Cancel one to make another.',
  );
  expect(card('Staff').queryByLabelText('Invite link')).toBeNull();
});

it('cancels a pending invite and drops it from the list', async () => {
  const api = fakeApi({ orgs: [owner], members: [...members] });
  api.data.invitations.push({
    id: 'i9',
    orgId: 'o1',
    label: 'Old link',
    createdAt: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-01-02T00:00:00.000Z',
    token: TOKEN,
  });
  const user = userEvent.setup();
  open('/orgs/o1');

  await user.click(
    await screen.findByRole('button', { name: 'Cancel invite for Old link' }),
  );

  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Cancel invite for Old link' }),
    ).toBeNull(),
  );
  expect(api.callsTo('DELETE', '/api/orgs/o1/invitations/i9')).toHaveLength(1);
});

it('asks before removing a staff member', async () => {
  const api = fakeApi({ orgs: [owner], members: [...members] });
  const user = userEvent.setup();
  open('/orgs/o1');

  await user.click(await screen.findByRole('button', { name: 'Remove Bob' }));
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByText('Remove Bob?')).toBeTruthy();
  await user.click(dialog.getByRole('button', { name: 'Keep' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.callsTo('DELETE', '/api/orgs/o1/members/u2')).toEqual([]);

  await user.click(screen.getByRole('button', { name: 'Remove Bob' }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Remove',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.callsTo('DELETE', '/api/orgs/o1/members/u2')).toHaveLength(1);
  expect(card('Staff').queryByText('Bob')).toBeNull();
});

// ---- The invited person ----

function inviteFrom(org: { id: string; name: string }) {
  const api = fakeApi({ orgs: [] });
  api.data.invitations.push({
    id: 'i1',
    orgId: org.id,
    orgName: org.name,
    label: 'For Asha',
    createdAt: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-01-02T00:00:00.000Z',
    token: TOKEN,
  });
  return api;
}

it('keeps the secret from /invite#… and moves to / with no # left', async () => {
  inviteFrom(owner);
  const router = open(`/invite#${TOKEN}`);

  await screen.findByText('Your organizations');
  expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  expect(router.state.location.pathname).toBe('/');
  expect(router.state.location.hash).toBe('');
  expect(router.state.historyAction).toBe('REPLACE');
});

it('shows who invited you and who you are, and Accept opens the organization', async () => {
  const api = inviteFrom(owner);
  const user = userEvent.setup();
  open(`/invite#${TOKEN}`);

  const invite = within(
    await screen.findByRole('region', { name: 'Invitation' }),
  );
  expect(invite.getByText('Northside Clinic')).toBeTruthy();
  expect(invite.getByText(/invited you to join as staff/)).toBeTruthy();
  expect(
    invite.getByText("You're signed in as asha@example.com."),
  ).toBeTruthy();
  expect(api.callsTo('POST', '/api/invitations/lookup')[0]!.body).toEqual({
    token: TOKEN,
  });

  await user.click(invite.getByRole('button', { name: 'Accept' }));

  expect(
    await screen.findByRole('heading', { name: 'Northside Clinic' }),
  ).toBeTruthy();
  expect(api.callsTo('POST', '/api/invitations/accept')[0]!.body).toEqual({
    token: TOKEN,
  });
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('Decline clears the card and the kept secret', async () => {
  const api = inviteFrom(owner);
  const user = userEvent.setup();
  open(`/invite#${TOKEN}`);

  await user.click(
    within(await screen.findByRole('region', { name: 'Invitation' })).getByRole(
      'button',
      { name: 'Decline' },
    ),
  );

  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Invitation' })).toBeNull(),
  );
  expect(api.callsTo('POST', '/api/invitations/decline')).toHaveLength(1);
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

const GONE =
  'This invite link has expired, was cancelled or was already used. Ask the owner for a new one.';

it('says a dead link is dead and forgets it', async () => {
  fakeApi({ orgs: [] });
  open(`/invite#${TOKEN}`);

  expect(await screen.findByText(GONE)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('says the same when the link is used up before Accept', async () => {
  const api = inviteFrom(owner);
  const user = userEvent.setup();
  open(`/invite#${TOKEN}`);

  const region = await screen.findByRole('region', { name: 'Invitation' });
  api.data.invitations.length = 0;
  await user.click(within(region).getByRole('button', { name: 'Accept' }));

  expect(await screen.findByText(GONE)).toBeTruthy();
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('looks nothing up when no link was opened', async () => {
  const api = fakeApi({ orgs: [] });
  open('/');

  await screen.findByText('Your organizations');
  expect(api.callsTo('POST', '/api/invitations/lookup')).toEqual([]);
  expect(screen.queryByRole('region', { name: 'Invitation' })).toBeNull();
});

it('asks to open the link again when the browser refuses to keep it', async () => {
  fakeApi({ orgs: [] });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  open(`/invite#${TOKEN}`);

  expect(
    await screen.findByText(
      "This browser didn't let us keep the invite. Sign in first, then open the link again.",
    ),
  ).toBeTruthy();
});
