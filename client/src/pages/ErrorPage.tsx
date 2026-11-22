import { useRouteError } from 'react-router';
import { ApiError } from '../api';

export function ErrorPage() {
  const error = useRouteError();
  const message =
    error instanceof ApiError ? error.message : 'Something went wrong';

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold">SlotDesk</h1>
      <p className="mt-4">{message}</p>
    </main>
  );
}
