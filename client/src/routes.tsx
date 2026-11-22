import { redirect, type RouteObject } from 'react-router';
import { ErrorPage } from './pages/ErrorPage';
import { Home, homeLoader } from './pages/Home';
import { NotFound } from './pages/NotFound';
import { SignIn, signInAction } from './pages/SignIn';
import { SignUp, signUpAction } from './pages/SignUp';
import { Page } from './Page';
import { getSession, redirectIfSignedIn, signOutAction } from './session';

export const routes: RouteObject[] = [
  {
    id: 'root',
    // Page reads this to show who is signed in.
    loader: getSession,
    ErrorBoundary: ErrorPage,
    // Shown while the first loader runs; a cold start on Render takes ~30 s.
    HydrateFallback: () => (
      <Page>
        <p className="text-muted">Loading…</p>
      </Page>
    ),
    children: [
      { path: '/', loader: homeLoader, Component: Home },
      {
        path: '/sign-in',
        loader: redirectIfSignedIn,
        action: signInAction,
        Component: SignIn,
      },
      {
        path: '/sign-up',
        loader: redirectIfSignedIn,
        action: signUpAction,
        Component: SignUp,
      },
      {
        path: '/sign-out',
        loader: () => redirect('/'),
        action: signOutAction,
      },
      { path: '*', Component: NotFound },
    ],
  },
];
