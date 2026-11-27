import { redirect, type RouteObject } from 'react-router';
import { ErrorPage } from './pages/ErrorPage';
import { Home, homeAction, homeLoader } from './pages/Home';
import { Invite } from './pages/Invite';
import { Manage } from './pages/Manage';
import { NotFound } from './pages/NotFound';
import {
  PublicBooking,
  publicBookingAction,
  publicBookingLoader,
} from './pages/PublicBooking';
import {
  Organization,
  organizationAction,
  organizationLoader,
} from './pages/Organization';
import { Resource, resourceAction, resourceLoader } from './pages/Resource';
import { SignIn, signInAction } from './pages/SignIn';
import { SignUp, signUpAction } from './pages/SignUp';
import { Page } from './Page';
import { Card } from './ui';
import { getSession, redirectIfSignedIn, signOutAction } from './session';

// Shown while the first loader runs; a cold start on Render takes ~30 s.
function Starting() {
  return (
    <Page>
      <Card title="Starting SlotDesk">
        <div role="status">
          <p className="text-muted-foreground mt-2">
            The server may take up to 30 seconds to wake up on the first visit.
          </p>
          <div className="mt-4 space-y-3 motion-safe:animate-pulse">
            <div className="bg-border h-4 w-3/4 rounded-lg" />
            <div className="bg-border h-4 w-full rounded-lg" />
            <div className="bg-border h-4 w-1/2 rounded-lg" />
          </div>
        </div>
      </Card>
    </Page>
  );
}

export const routes: RouteObject[] = [
  {
    id: 'root',
    // Page reads this to show who is signed in.
    loader: getSession,
    ErrorBoundary: ErrorPage,
    HydrateFallback: Starting,
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
      // An invite link: keeps its secret and moves on to the home page.
      { path: '/invite', Component: Invite },
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
  // The customer's booking page sits outside 'root': no session is read, so
  // the header never shows who is signed in.
  {
    path: '/book/:slug',
    loader: publicBookingLoader,
    action: publicBookingAction,
    Component: PublicBooking,
    ErrorBoundary: ErrorPage,
    HydrateFallback: Starting,
  },
  // The customer's cancel link, outside 'root' for the same reason.
  { path: '/manage', Component: Manage, ErrorBoundary: ErrorPage },
];
