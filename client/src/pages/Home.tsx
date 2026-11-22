import { useLoaderData } from 'react-router';
import { Page } from '../Page';
import { requireUser } from '../session';

export function homeLoader() {
  return requireUser();
}

export function Home() {
  const user = useLoaderData<typeof homeLoader>();

  return (
    <Page>
      <h1 className="text-2xl font-semibold">SlotDesk</h1>
      <p className="text-muted mt-4">{`Signed in as ${user.email}.`}</p>
    </Page>
  );
}
