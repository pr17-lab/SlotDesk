import { redirect, type RouteObject } from 'react-router';
import { ErrorPage } from './pages/ErrorPage';
import { Home, homeAction, homeLoader } from './pages/Home';
import { NotFound } from './pages/NotFound';
import {
  Organization,
  organizationAction,
  organizationLoader,
} from './pages/Organization';
import { Resource, resourceAction, resourceLoader } from './pages/Resource';
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
      {
        path: '/',
        loader: homeLoader,
        action: homeAction,
        Component: Home,
      },
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
      {
        path: '/orgs/:orgId',
        loader: organizationLoader,
        action: organizationAction,
        Component: Organization,
      },
      {
        path: '/orgs/:orgId/resources/:resourceId',
        loader: resourceLoader,
        action: resourceAction,
        Component: Resource,
      },
      { path: '*', Component: NotFound },
    ],
  },
];
