import { Link } from 'react-router';
import { Page } from '../Page';
import { Card, focusStyle } from '../ui';

export function NotFound() {
  return (
    <Page>
      <Card title="Page not found">
        <p className="text-muted-foreground mt-2">Page not found.</p>
        <Link
          to="/"
          className={`text-primary mt-4 inline-block rounded-lg underline ${focusStyle}`}
        >
          Go to the home page
        </Link>
      </Card>
    </Page>
  );
}
