import { Link } from 'react-router';
import { Page } from '../Page';
import { focusStyle } from '../ui';

export function NotFound() {
  return (
    <Page>
      <h1 className="text-2xl font-semibold">SlotDesk</h1>
      <p className="text-muted mt-4">Page not found.</p>
      <Link
        to="/"
        className={`rounded-control text-accent mt-4 inline-block underline ${focusStyle}`}
      >
        Go to the home page
      </Link>
    </Page>
  );
}
