import { Building2, MailOpen } from 'lucide-react';
import {
  redirect,
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
} from 'react-router';
import { Button } from '@/components/ui/button';
import { api, ApiError, errorToData, type Org } from '../api';
import { Page } from '../Page';
import { requireUser } from '../session';
import {
  Card,
  FormMessage,
  ListRow,
  RoleBadge,
  SecondaryButton,
  TextField,
} from '../ui';
import { forgetInviteToken, keptInviteToken } from './Invite';

const GONE =
  'This invite link has expired, was cancelled or was already used. Ask the owner for a new one.';

export async function homeLoader() {
  const user = await requireUser();
  const [orgs, invite] = await Promise.all([api<Org[]>('/orgs'), findInvite()]);
  return { user, orgs, invite };
}

// The invite link this tab opened, if any: who it is from, or 'gone'.
async function findInvite(): Promise<{ orgName: string } | 'gone' | null> {
  const token = keptInviteToken();
  if (!token) return null;
  try {
    return await api<{ orgName: string }>('/invitations/lookup', {
      method: 'POST',
      body: { token },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      forgetInviteToken();
      return 'gone';
    }
    throw error;
  }
}

async function answerInvite(intent: 'accept' | 'decline') {
  const token = keptInviteToken();
  if (!token) return { error: GONE };
  try {
    if (intent === 'decline') {
      await api('/invitations/decline', { method: 'POST', body: { token } });
      forgetInviteToken();
      return null;
    }
    const joined = await api<{ orgId: string }>('/invitations/accept', {
      method: 'POST',
      body: { token },
    });
    forgetInviteToken();
    return redirect(`/orgs/${joined.orgId}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      forgetInviteToken();
      return { error: GONE };
    }
    if (error instanceof ApiError && error.status === 409) {
      forgetInviteToken();
      return { error: "You're already in this organization." };
    }
    return errorToData(error);
  }
}

export async function homeAction({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const intent = form.get('intent');
  if (intent === 'accept' || intent === 'decline') return answerInvite(intent);
  const name = String(form.get('name')).trim();

  try {
    const org = await api<Org>('/orgs', { method: 'POST', body: { name } });
    return redirect(`/orgs/${org.id}`);
  } catch (error) {
    return errorToData(error);
  }
}

function InviteCard({
  invite,
  email,
}: {
  invite: { orgName: string } | 'gone' | null;
  email: string;
}) {
  const fetcher = useFetcher<typeof homeAction>();
  const busy = fetcher.state !== 'idle';
  const failed =
    fetcher.data && 'error' in fetcher.data ? fetcher.data : undefined;
  if (!invite && !failed) return null;

  return (
    <Card title="Invitation" icon={MailOpen}>
      {failed || invite === 'gone' || !invite ? (
        <p role="alert" className="mt-2">
          {failed?.error ?? GONE}
        </p>
      ) : (
        <>
          <p className="mt-2">
            <strong>{invite.orgName}</strong> invited you to join as staff.
          </p>
          <p className="text-muted-foreground mt-1">{`You're signed in as ${email}.`}</p>
          <fetcher.Form method="post" className="mt-4 flex flex-wrap gap-3">
            <Button type="submit" name="intent" value="accept" disabled={busy}>
              Accept
            </Button>
            <SecondaryButton
              type="submit"
              name="intent"
              value="decline"
              disabled={busy}
            >
              Decline
            </SecondaryButton>
          </fetcher.Form>
        </>
      )}
    </Card>
  );
}

export function Home() {
  const { user, orgs, invite } = useLoaderData<typeof homeLoader>();
  const fetcher = useFetcher<typeof homeAction>();
  const creating = fetcher.state !== 'idle';

  return (
    <Page>
      <h1 className="text-3xl font-semibold tracking-tight">
        Your organizations
      </h1>
      <p className="text-muted-foreground mt-1">{`Signed in as ${user.email}.`}</p>

      <div className="mt-8 space-y-6">
        <InviteCard invite={invite} email={user.email} />
        <Card title="Organizations" icon={Building2}>
          {orgs.length === 0 ? (
            <p className="text-muted-foreground mt-2">
              Welcome. Create your first organization to begin.
            </p>
          ) : (
            <ul className="divide-border mt-2 divide-y">
              {orgs.map((org) => (
                <ListRow
                  key={org.id}
                  to={`/orgs/${org.id}`}
                  name={org.name}
                  detail={<RoleBadge role={org.role} />}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="New organization">
          <fetcher.Form method="post" className="mt-4 space-y-4">
            <TextField label="Name" name="name" required maxLength={100} />
            <Button type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create organization'}
            </Button>
            <FormMessage result={fetcher.data} />
          </fetcher.Form>
        </Card>
      </div>
    </Page>
  );
}
