import { Link } from 'react-router';

export function NotFound() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold">SlotDesk</h1>
      <p className="mt-4">Page not found.</p>
      <Link to="/" className="mt-4 inline-block underline">
        Go to the home page
      </Link>
    </main>
  );
}
