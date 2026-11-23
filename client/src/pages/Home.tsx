import {
  redirect,
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
} from 'react-router';
import { api, errorToData, type Org } from '../api';
import { Page } from '../Page';
import { requireUser } from '../session';
import {
  Button,
  Card,
  FormMessage,
  ListRow,
  RoleBadge,
  TextField,
} from '../ui';

export async function homeLoader() {
  const user = await requireUser();
  const orgs = await api<Org[]>('/orgs');
  return { user, orgs };
}

export async function homeAction({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const name = String(form.get('name')).trim();

  try {
    const org = await api<Org>('/orgs', { method: 'POST', body: { name } });
    return redirect(`/orgs/${org.id}`);
  } catch (error) {
    return errorToData(error);
  }
}

export function Home() {
  const { user, orgs } = useLoaderData<typeof homeLoader>();
  const fetcher = useFetcher<typeof homeAction>();
  const creating = fetcher.state !== 'idle';

  return (
    <Page>
      <h1 className="text-2xl font-semibold">Your organizations</h1>
      <p className="text-muted mt-1">{`Signed in as ${user.email}.`}</p>

      <div className="mt-8 space-y-6">
        <Card title="Organizations">
          {orgs.length === 0 ? (
            <p className="text-muted mt-2">
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
