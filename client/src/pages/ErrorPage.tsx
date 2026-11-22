import { useRouteError } from 'react-router';
import { ApiError } from '../api';
import { Page } from '../Page';

export function ErrorPage() {
  const error = useRouteError();
  const message =
    error instanceof ApiError ? error.message : 'Something went wrong';

  return (
    <Page>
      <h1 className="text-2xl font-semibold">SlotDesk</h1>
      <p className="text-danger mt-4">{message}</p>
    </Page>
  );
}
