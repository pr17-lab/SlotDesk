import type { RouteObject } from 'react-router';
import { ErrorPage } from './pages/ErrorPage';
import { Home, homeLoader } from './pages/Home';
import { NotFound } from './pages/NotFound';

export const routes: RouteObject[] = [
  {
    path: '/',
    loader: homeLoader,
    Component: Home,
    ErrorBoundary: ErrorPage,
    // Shown while the first loader runs; a cold start on Render takes ~30 s.
    HydrateFallback: () => <p className="p-8">Loading…</p>,
  },
  { path: '*', Component: NotFound },
];
