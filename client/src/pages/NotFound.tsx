import { Link } from 'react-router';
import { Page } from '../Page';

export function NotFound() {
  return (
    <Page>
      <h1 className="text-2xl font-semibold">SlotDesk</h1>
      <p className="text-muted mt-4">Page not found.</p>
      <Link
        to="/"
        className="rounded-control text-accent focus-visible:outline-accent mt-4 inline-block underline focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        Go to the home page
      </Link>
    </Page>
  );
}
