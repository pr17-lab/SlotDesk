import { Clock, DoorOpen, Globe, Users } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Link,
  redirect,
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import {
  api,
  ApiError,
  errorToData,
  pathParam,
  type Invitation,
  type Member,
  type Org,
} from '../api';
import { Page } from '../Page';
import { requireUser } from '../session';
import { browserTimeZone, TimeZonePicker } from '../TimeZonePicker';
import {
  Badge,
  Breadcrumb,
  Card,
  CopyButton,
  FormMessage,
  ListRow,
  Modal,
  RoleBadge,
  SecondaryButton,
  TextField,
  focusStyle,
} from '../ui';

type Resource = { id: string; name: string; timeZone: string };
type Service = { id: string; name: string; durationMinutes: number };

export async function organizationLoader({ params }: LoaderFunctionArgs) {
  await requireUser();
  const orgId = pathParam(params, 'orgId');
  const [org, resources, services] = await Promise.all([
    api<Org>(`/orgs/${orgId}`),
    api<Resource[]>(`/orgs/${orgId}/resources`),
    api<Service[]>(`/orgs/${orgId}/services`),
  ]);
  // Only the owner sees the Staff card, so only the owner loads its lists.
  const staff =
    org.role === 'owner'
      ? await Promise.all([
          api<Member[]>(`/orgs/${orgId}/members`),
          api<Invitation[]>(`/orgs/${orgId}/invitations`),
        ])
      : null;
  return {
    org,
    resources,
    services,
    staff: staff && { members: staff[0], invitations: staff[1] },
  };
}

// One action for the page's forms; each says which with `intent`.
export async function organizationAction({
  request,
  params,
}: ActionFunctionArgs) {
  const orgId = pathParam(params, 'orgId');
  const form = await request.formData();
  const intent = form.get('intent');
  const name = String(form.get('name')).trim();

  try {
    if (intent === 'add-resource') {
      const timeZone = String(form.get('timeZone'));
      await api(`/orgs/${orgId}/resources`, {
        method: 'POST',
        body: { name, timeZone },
      });
      return { notice: 'Resource added' };
    }

    if (intent === 'add-service') {
      // Checked here so the person gets a clear message before any request.
      const text = String(form.get('durationMinutes')).trim();
      const durationMinutes = Number(text);
      if (
        !/^\d+$/.test(text) ||
        durationMinutes < 5 ||
        durationMinutes > 480 ||
        durationMinutes % 5 !== 0
      ) {
        return { error: 'Duration must be 5 to 480 minutes, in steps of 5' };
      }
      await api(`/orgs/${orgId}/services`, {
        method: 'POST',
        body: { name, durationMinutes },
      });
      return { notice: 'Service added' };
    }

    // The server trims and lowercases the name; null turns the page off.
    if (intent === 'booking-link' || intent === 'booking-off') {
      const bookingSlug =
        intent === 'booking-off' ? null : String(form.get('bookingSlug'));
      await api(`/orgs/${orgId}`, { method: 'PATCH', body: { bookingSlug } });
      return {
        notice: bookingSlug ? 'Online booking is on' : 'Online booking is off',
      };
    }

    if (intent === 'invite') {
      const created = await api<{ token: string }>(
        `/orgs/${orgId}/invitations`,
        { method: 'POST', body: { label: String(form.get('label')) } },
      );
      return { notice: 'Invite link ready', token: created.token };
    }

    if (intent === 'cancel-invite') {
      await api(`/orgs/${orgId}/invitations/${String(form.get('id'))}`, {
        method: 'DELETE',
      });
      return { notice: 'Invite cancelled' };
    }

    if (intent === 'remove-member') {
      await api(`/orgs/${orgId}/members/${String(form.get('userId'))}`, {
        method: 'DELETE',
      });
      return { notice: 'Removed' };
    }

    if (intent === 'sample-data') {
      const created = await api<{ resource: Resource }>(
        `/orgs/${orgId}/sample-data`,
        { method: 'POST', body: { timeZone: String(form.get('timeZone')) } },
      );
      return redirect(`/orgs/${orgId}/resources/${created.resource.id}`);
    }
  } catch (error) {
    // Someone else added data first: no error, the lists just reload.
    if (
      intent === 'sample-data' &&
      error instanceof ApiError &&
      error.status === 409
    ) {
      return null;
    }
    if (
      intent === 'invite' &&
      error instanceof ApiError &&
      error.status === 409
    ) {
      return {
        error: 'You have 20 invites waiting. Cancel one to make another.',
      };
    }
    // Already gone (cancelled or removed elsewhere): the lists just reload.
    if (
      (intent === 'cancel-invite' || intent === 'remove-member') &&
      error instanceof ApiError &&
      error.status === 404
    ) {
      return null;
    }
    if (
      intent === 'booking-link' &&
      error instanceof ApiError &&
      error.status === 409
    ) {
      return { error: 'That link name is taken. Try another.' };
    }
    return errorToData(error);
  }
  return { error: 'Something went wrong' };
}

// Clears a create form's fields once its action reports success.
function useResetOnSuccess(
  data: { error?: string; notice?: string } | null | undefined,
  form: RefObject<HTMLFormElement | null>,
) {
  useEffect(() => {
    if (data?.notice) form.current?.reset();
  }, [data, form]);
}

function SampleDataCard() {
  const fetcher = useFetcher<typeof organizationAction>();
  const creating = fetcher.state !== 'idle';

  return (
    <Card title="Get started">
      <p className="text-muted-foreground mt-2">
        Start with a sample room, a 30-minute service and weekday hours.
      </p>
      <fetcher.Form method="post" className="mt-4 space-y-4">
        <input type="hidden" name="intent" value="sample-data" />
        <input type="hidden" name="timeZone" value={browserTimeZone()} />
        <Button type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'Create sample data'}
        </Button>
        <FormMessage result={fetcher.data} />
      </fetcher.Form>
    </Card>
  );
}

function AddResourceCard() {
  const fetcher = useFetcher<typeof organizationAction>();
  const form = useRef<HTMLFormElement>(null);
  const saving = fetcher.state !== 'idle';
  useResetOnSuccess(fetcher.data, form);

  return (
    <Card title="Add resource">
      <fetcher.Form method="post" ref={form} className="mt-4 space-y-4">
        <input type="hidden" name="intent" value="add-resource" />
        <TextField label="Name" name="name" required maxLength={100} />
        <TimeZonePicker hint="The time zone can't be changed later" />
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Add resource'}
        </Button>
        <FormMessage result={fetcher.data} />
      </fetcher.Form>
    </Card>
  );
}

function AddServiceCard() {
  const fetcher = useFetcher<typeof organizationAction>();
  const form = useRef<HTMLFormElement>(null);
  const saving = fetcher.state !== 'idle';
  useResetOnSuccess(fetcher.data, form);

  return (
    <Card title="Add service">
      <fetcher.Form method="post" ref={form} className="mt-4 space-y-4">
        <input type="hidden" name="intent" value="add-service" />
        <TextField label="Name" name="name" required maxLength={100} />
        {/* No min, max or step: the browser's own check would hide ours. */}
        <TextField
          label="Duration (minutes)"
          name="durationMinutes"
          inputMode="numeric"
          required
          hint="5 to 480, in steps of 5"
        />
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Add service'}
        </Button>
        <FormMessage result={fetcher.data} />
      </fetcher.Form>
    </Card>
  );
}

// The owner turns the customer booking page on or off and picks its link.
// Staff see the link while it is on, and nothing while it is off.
function OnlineBookingCard({ org }: { org: Org }) {
  const fetcher = useFetcher<typeof organizationAction>();
  const saving = fetcher.state !== 'idle';
  const isOwner = org.role === 'owner';
  const slug = org.bookingSlug;
  if (!isOwner && !slug) return null;

  return (
    <Card title="Online booking" icon={Globe}>
      {slug ? (
        <p className="mt-2">
          {'Customers book at '}
          <Link
            to={`/book/${slug}`}
            className={`text-primary rounded-lg font-medium break-all hover:underline ${focusStyle}`}
          >
            {`${window.location.origin}/book/${slug}`}
          </Link>
        </p>
      ) : (
        <p className="text-muted-foreground mt-2">
          Let customers book themselves at a link you choose.
        </p>
      )}
      {isOwner && (
        // A new key when the link changes, so the field shows the saved name.
        <fetcher.Form method="post" key={slug} className="mt-4 space-y-4">
          <TextField
            label="Link name"
            name="bookingSlug"
            defaultValue={slug ?? ''}
            required
            maxLength={40}
            hint="3 to 40 letters, digits or hyphens. Changing it breaks links you have shared."
          />
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              name="intent"
              value="booking-link"
              disabled={saving}
            >
              {saving
                ? 'Saving…'
                : slug
                  ? 'Save link'
                  : 'Turn on online booking'}
            </Button>
            {slug && (
              <SecondaryButton
                type="submit"
                name="intent"
                value="booking-off"
                formNoValidate
                disabled={saving}
              >
                Turn off
              </SecondaryButton>
            )}
          </div>
          <FormMessage result={fetcher.data} />
        </fetcher.Form>
      )}
    </Card>
  );
}

const expiry = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function PendingInvite({ invitation }: { invitation: Invitation }) {
  const fetcher = useFetcher<typeof organizationAction>();
  return (
    <ListRow
      name={invitation.label}
      detail={
        <>
          {`Expires ${expiry.format(new Date(invitation.expiresAt))}`}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="cancel-invite" />
            <input type="hidden" name="id" value={invitation.id} />
            <SecondaryButton
              small
              type="submit"
              aria-label={`Cancel invite for ${invitation.label}`}
              disabled={fetcher.state !== 'idle'}
            >
              Cancel
            </SecondaryButton>
          </fetcher.Form>
        </>
      }
    />
  );
}

// Owner only: who is in the organization, invite links, and removing staff.
function StaffCard({
  members,
  invitations,
}: {
  members: Member[];
  invitations: Invitation[];
}) {
  const invite = useFetcher<typeof organizationAction>();
  const form = useRef<HTMLFormElement>(null);
  useResetOnSuccess(invite.data, form);
  const token =
    invite.data && 'token' in invite.data ? invite.data.token : undefined;
  const link = token && `${window.location.origin}/invite#${token}`;

  // A new fetcher for each removal, so the dialog opens clean every time.
  const [chosen, setChosen] = useState<Member | null>(null);
  const [attempt, setAttempt] = useState(0);
  const remove = useFetcher<typeof organizationAction>({
    key: `remove-${attempt}`,
  });
  const removed = remove.data && 'notice' in remove.data;

  return (
    <Card title="Staff" icon={Users}>
      <ul className="divide-border mt-2 divide-y">
        {members.map((member) => (
          <li
            key={member.userId}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
          >
            <div className="min-w-0">
              <p className="font-medium">{member.name}</p>
              <p className="text-muted-foreground text-sm break-all">
                {member.email}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <RoleBadge role={member.role} />
              {member.role === 'staff' && (
                <SecondaryButton
                  small
                  type="button"
                  aria-label={`Remove ${member.name}`}
                  onClick={() => {
                    setChosen(member);
                    setAttempt(attempt + 1);
                  }}
                >
                  Remove
                </SecondaryButton>
              )}
            </div>
          </li>
        ))}
      </ul>

      <invite.Form method="post" ref={form} className="mt-6 space-y-4">
        <input type="hidden" name="intent" value="invite" />
        <TextField
          label="Who is it for?"
          name="label"
          required
          maxLength={100}
          hint="Only you see this, to tell your links apart"
        />
        <Button type="submit" disabled={invite.state !== 'idle'}>
          {invite.state !== 'idle' ? 'Creating…' : 'Create invite link'}
        </Button>
        {!link && <FormMessage result={invite.data} />}
      </invite.Form>

      {link && (
        <div className="mt-4 space-y-3">
          <TextField
            label="Invite link"
            value={link}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <p className="text-muted-foreground text-sm">
            Send this link to them yourself. It works once, for 24 hours. You
            won&apos;t see it again.
          </p>
          <CopyButton key={link} text={link} />
        </div>
      )}

      {invitations.length > 0 && (
        <>
          <h3 className="mt-6 font-medium">Waiting to be accepted</h3>
          <ul className="divide-border mt-2 divide-y">
            {invitations.map((invitation) => (
              <PendingInvite key={invitation.id} invitation={invitation} />
            ))}
          </ul>
        </>
      )}

      {chosen && !removed && (
        <Modal title={`Remove ${chosen.name}?`} onClose={() => setChosen(null)}>
          <p className="mt-2">
            {`${chosen.email} loses access to this organization at once. You can invite them again later.`}
          </p>
          <remove.Form method="post" className="mt-4 space-y-4">
            <input type="hidden" name="intent" value="remove-member" />
            <input type="hidden" name="userId" value={chosen.userId} />
            <FormMessage result={remove.data} />
            <div className="flex flex-wrap gap-3">
              <DialogClose render={<SecondaryButton type="button" />}>
                Keep
              </DialogClose>
              <Button
                type="submit"
                variant="destructive"
                disabled={remove.state !== 'idle'}
              >
                {remove.state !== 'idle' ? 'Removing…' : 'Remove'}
              </Button>
            </div>
          </remove.Form>
        </Modal>
      )}
    </Card>
  );
}

export function Organization() {
  const { org, resources, services, staff } =
    useLoaderData<typeof organizationLoader>();
  const isOwner = org.role === 'owner';
  const isEmpty = resources.length === 0 && services.length === 0;

  return (
    <Page wide>
      <Breadcrumb
        items={[{ label: 'Organizations', to: '/' }, { label: org.name }]}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{org.name}</h1>
        <RoleBadge role={org.role} />
      </div>

      {isOwner && isEmpty && (
        <div className="mt-8">
          <SampleDataCard />
        </div>
      )}

      <div className="mt-8 grid items-start gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <Card title="Resources" icon={DoorOpen}>
            {resources.length === 0 ? (
              <p className="text-muted-foreground mt-2">No resources yet.</p>
            ) : (
              <ul className="divide-border mt-2 divide-y">
                {resources.map((resource) => (
                  <ListRow
                    key={resource.id}
                    to={`/orgs/${org.id}/resources/${resource.id}`}
                    name={resource.name}
                    detail={resource.timeZone}
                  />
                ))}
              </ul>
            )}
          </Card>
          {isOwner && <AddResourceCard />}
        </div>

        <div className="space-y-6">
          <Card title="Services" icon={Clock}>
            {services.length === 0 ? (
              <p className="text-muted-foreground mt-2">No services yet.</p>
            ) : (
              <ul className="divide-border mt-2 divide-y">
                {services.map((service) => (
                  <ListRow
                    key={service.id}
                    name={service.name}
                    detail={<Badge>{`${service.durationMinutes} min`}</Badge>}
                  />
                ))}
              </ul>
            )}
          </Card>
          {isOwner && <AddServiceCard />}
        </div>
      </div>

      <div className="mt-6">
        <OnlineBookingCard org={org} />
      </div>

      {staff && (
        <div className="mt-6">
          <StaffCard members={staff.members} invitations={staff.invitations} />
        </div>
      )}
    </Page>
  );
}
