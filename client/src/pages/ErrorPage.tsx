import { Link, useRouteError } from 'react-router';
import { ApiError } from '../api';
import { Page } from '../Page';
import { focusStyle } from '../ui';
import { NotFound } from './NotFound';

export function ErrorPage() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  const message =
    error instanceof ApiError ? error.message : 'Something went wrong';

  return (
    <Page>
      <h1 className="text-2xl font-semibold">SlotDesk</h1>
      <p className="text-danger mt-4">{message}</p>
      {error instanceof ApiError && error.status === 401 && (
        <Link
          to="/sign-in"
          className={`rounded-control text-accent mt-4 inline-block underline ${focusStyle}`}
        >
          Sign in
        </Link>
      )}
    </Page>
  );
}
