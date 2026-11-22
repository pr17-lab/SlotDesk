import { useLoaderData } from 'react-router';
import { api } from '../api';
import { Page } from '../Page';

type Session = { user: { email: string } } | null;

export async function homeLoader() {
  return api<Session>('/auth/get-session');
}

export function Home() {
  const session = useLoaderData<typeof homeLoader>();

  return (
    <Page>
      <h1 className="text-2xl font-semibold">SlotDesk</h1>
      <p className="text-muted mt-4">
        {session
          ? `Signed in as ${session.user.email}.`
          : 'You are signed out.'}
      </p>
    </Page>
  );
}
