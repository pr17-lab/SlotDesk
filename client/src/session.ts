import { redirect } from 'react-router';
import { api } from './api';

export type Session = { user: { name: string; email: string } } | null;

// The server answers 200 with null when nobody is signed in.
export function getSession() {
  return api<Session>('/auth/get-session');
}

// For loaders of pages that need a signed-in user.
export async function requireUser() {
  const session = await getSession();
  if (!session) throw redirect('/sign-in');
  return session.user;
}

// For the sign-in and sign-up loaders: nothing to do when already signed in.
export async function redirectIfSignedIn() {
  const session = await getSession();
  if (session) throw redirect('/');
  return null;
}

export async function signOutAction() {
  await api('/auth/sign-out', { method: 'POST' });
  return redirect('/sign-in');
}
