import { Link } from 'react-router';
import { Page } from '../Page';
import { Card, focusStyle } from '../ui';

export function NotFound() {
  return (
    <Page>
      <Card title="Page not found">
        <p className="text-muted mt-2">Page not found.</p>
        <Link
          to="/"
          className={`rounded-control text-accent mt-4 inline-block underline ${focusStyle}`}
        >
          Go to the home page
        </Link>
      </Card>
    </Page>
  );
}
