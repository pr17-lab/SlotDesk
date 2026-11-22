import { useLoaderData } from 'react-router';
import { api } from '../api';

type Session = { user: { email: string } } | null;

export async function homeLoader() {
  return api<Session>('/auth/get-session');
}

export function Home() {
  const session = useLoaderData<typeof homeLoader>();

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold">SlotDesk</h1>
      <p className="mt-4">
        {session
          ? `Signed in as ${session.user.email}.`
          : 'You are signed out.'}
      </p>
    </main>
  );
}
