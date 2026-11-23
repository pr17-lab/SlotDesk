import { useEffect, useRef, type RefObject } from 'react';
import {
  redirect,
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { api, ApiError, errorToData, pathParam, type Org } from '../api';
import { Page } from '../Page';
import { requireUser } from '../session';
import { browserTimeZone, TimeZonePicker } from '../TimeZonePicker';
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  FormMessage,
  ListRow,
  RoleBadge,
  TextField,
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
  return { org, resources, services };
}

// One action for the page's three forms; each sends a hidden `intent`.
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
      <p className="text-muted mt-2">
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

export function Organization() {
  const { org, resources, services } =
    useLoaderData<typeof organizationLoader>();
  const isOwner = org.role === 'owner';
  const isEmpty = resources.length === 0 && services.length === 0;

  return (
    <Page wide>
      <Breadcrumb
        items={[{ label: 'Organizations', to: '/' }, { label: org.name }]}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{org.name}</h1>
        <RoleBadge role={org.role} />
      </div>

      {isOwner && isEmpty && (
        <div className="mt-8">
          <SampleDataCard />
        </div>
      )}

      <div className="mt-8 grid items-start gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <Card title="Resources">
            {resources.length === 0 ? (
              <p className="text-muted mt-2">No resources yet.</p>
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
          <Card title="Services">
            {services.length === 0 ? (
              <p className="text-muted mt-2">No services yet.</p>
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
    </Page>
  );
}
