import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { routes } from '../src/routes';
import { fakeApi, type Org } from './fake-api';

const owner: Org = { id: 'o1', name: 'Northside Clinic', role: 'owner' };
const staff: Org = { ...owner, role: 'staff' };
const room = { id: 'r1', name: 'Room 1', timeZone: 'Europe/London' };
const visit = { id: 's1', name: 'Check-up', durationMinutes: 30 };

function open(path = '/orgs/o1') {
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: [path] })}
    />,
  );
}

// The card with this title, so the two Name fields can be told apart.
const card = (title: string) =>
  within(screen.getByRole('region', { name: title }));

// Pins the browser's own time zone so the tests give the same result on
// any laptop and in CI.
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

function browserZoneIs(timeZone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(
    function (this: Intl.DateTimeFormat) {
      return { ...realResolvedOptions.call(this), timeZone };
    },
  );
}

beforeEach(() => browserZoneIs('Asia/Calcutta'));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('lists resources with their zone and services with their length', async () => {
  fakeApi({ orgs: [owner], resources: [room], services: [visit] });
  open();

  const link = await screen.findByRole('link', { name: 'Room 1' });
  expect(link.getAttribute('href')).toBe('/orgs/o1/resources/r1');
  expect(screen.getByText('Europe/London')).toBeTruthy();
  expect(screen.getByText('Check-up')).toBeTruthy();
  expect(screen.getByText('30 min')).toBeTruthy();
});

it('shows staff the lists only', async () => {
  fakeApi({ orgs: [staff] });
  open();

  expect(await screen.findByText('No resources yet.')).toBeTruthy();
  expect(screen.getByText('No services yet.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add resource' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add service' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Create sample data' }),
  ).toBeNull();
});

it('shows page not found for an unknown organization', async () => {
  fakeApi({ orgs: [owner] });
  open('/orgs/nope');

  expect(await screen.findByText('Page not found.')).toBeTruthy();
});

it('shows only the running form as busy', async () => {
  const api = fakeApi({ orgs: [owner], resources: [room], services: [visit] });
  const release = api.hold('POST', '/api/orgs/o1/services');
  open();

  await screen.findByRole('region', { name: 'Add service' });
  await userEvent.type(card('Add service').getByLabelText('Name'), 'Cleaning');
  await userEvent.type(
    card('Add service').getByLabelText('Duration (minutes)'),
    '45',
  );
  await userEvent.click(card('Add service').getByRole('button'));

  const saving = await screen.findByRole('button', { name: 'Saving…' });
  expect((saving as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByRole('button', { name: 'Saving…' })).toHaveLength(1);
  const addResource = card('Add resource').getByRole('button');
  expect(addResource.textContent).toBe('Add resource');
  expect((addResource as HTMLButtonElement).disabled).toBe(false);

  release();
  expect(await screen.findByText('Service added')).toBeTruthy();
});

it('rejects a duration of 7 without sending a request', async () => {
  const api = fakeApi({ orgs: [owner], resources: [room], services: [visit] });
  open();

  await screen.findByRole('region', { name: 'Add service' });
  await userEvent.type(card('Add service').getByLabelText('Name'), 'Cleaning');
  await userEvent.type(
    card('Add service').getByLabelText('Duration (minutes)'),
    '7',
  );
  await userEvent.click(card('Add service').getByRole('button'));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(
    'Duration must be 5 to 480 minutes, in steps of 5',
  );
  expect(api.callsTo('POST', '/api/orgs/o1/services')).toHaveLength(0);
});

it('adds a resource with the picked zone and clears the name', async () => {
  const api = fakeApi({ orgs: [owner], resources: [room], services: [visit] });
  open();

  await screen.findByRole('region', { name: 'Add resource' });
  await userEvent.type(card('Add resource').getByLabelText('Name'), 'Room 2');
  await userEvent.click(card('Add resource').getByRole('button'));

  expect(await screen.findByText('Resource added')).toBeTruthy();
  expect(api.callsTo('POST', '/api/orgs/o1/resources')[0].body).toEqual({
    name: 'Room 2',
    timeZone: 'Asia/Kolkata',
  });
  const name = card('Add resource').getByLabelText('Name') as HTMLInputElement;
  expect(name.value).toBe('');
});

it('hides sample data when the organization already has data', async () => {
  fakeApi({ orgs: [owner], resources: [room] });
  open();

  await screen.findByRole('link', { name: 'Room 1' });
  expect(
    screen.queryByRole('button', { name: 'Create sample data' }),
  ).toBeNull();
});

it('creates sample data once with the browser zone and opens the resource', async () => {
  const api = fakeApi({ orgs: [owner] });
  open();

  await userEvent.click(
    await screen.findByRole('button', { name: 'Create sample data' }),
  );

  expect(
    await screen.findByRole('heading', { name: 'Sample room' }),
  ).toBeTruthy();
  const posts = api.callsTo('POST', '/api/orgs/o1/sample-data');
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({ timeZone: 'Asia/Kolkata' });
});

it('reloads the lists when sample data answers 409', async () => {
  const api = fakeApi({ orgs: [owner] });
  open();
  const button = await screen.findByRole('button', {
    name: 'Create sample data',
  });
  const loadsBefore = api.callsTo('GET', '/api/orgs/o1/resources').length;
  // Someone else adds a resource while this page is open.
  api.data.resources.push({
    id: 'r9',
    name: 'Added elsewhere',
    timeZone: 'UTC',
  });

  await userEvent.click(button);

  expect(
    await screen.findByRole('link', { name: 'Added elsewhere' }),
  ).toBeTruthy();
  expect(api.callsTo('GET', '/api/orgs/o1/resources').length).toBeGreaterThan(
    loadsBefore,
  );
  expect(screen.queryByRole('alert')).toBeNull();
});

it('starts the time zone picker on the browser zone, mapped', async () => {
  fakeApi({ orgs: [owner] });
  open();

  const picker = await screen.findByRole('combobox', { name: 'Time zone' });
  expect((picker as HTMLInputElement).value).toBe('Asia/Kolkata');
});

it('filters the picker as you type and sends the picked zone', async () => {
  const api = fakeApi({ orgs: [owner], resources: [room] });
  // A zone that is not the default, so picking it changes something.
  browserZoneIs('Europe/London');
  open();

  const picker = await screen.findByRole('combobox', { name: 'Time zone' });
  await userEvent.clear(picker);
  await userEvent.type(picker, 'kolk');
  const option = await screen.findByRole('option', { name: /Asia\/Kolkata/ });
  expect(option.textContent).toContain('GMT+05:30');
  await userEvent.click(option);

  await userEvent.type(card('Add resource').getByLabelText('Name'), 'Room 3');
  await userEvent.click(card('Add resource').getByRole('button'));

  await screen.findByText('Resource added');
  expect(api.callsTo('POST', '/api/orgs/o1/resources')[0].body).toEqual({
    name: 'Room 3',
    timeZone: 'Asia/Kolkata',
  });
});
