import { Link, useRouteError } from 'react-router';
import { ApiError } from '../api';
import { Page } from '../Page';
import { Button, Card, focusStyle } from '../ui';
import { NotFound } from './NotFound';

export function ErrorPage() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  const message =
    error instanceof ApiError ? error.message : 'Something went wrong';

  return (
    <Page>
      <Card title="That didn't work">
        <p className="text-danger mt-2">{message}</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Button type="button" onClick={() => window.location.reload()}>
            Try again
          </Button>
          {error instanceof ApiError && error.status === 401 && (
            <Link
              to="/sign-in"
              className={`rounded-control text-accent underline ${focusStyle}`}
            >
              Sign in
            </Link>
          )}
          <Link
            to="/"
            className={`rounded-control text-accent underline ${focusStyle}`}
          >
            Go to the home page
          </Link>
        </div>
      </Card>
    </Page>
  );
}
