import type { ReactNode } from 'react';
import { Form, Link, useRouteLoaderData } from 'react-router';
import type { Session } from './session';
import { Button, focusStyle } from './ui';

export function Page({ children }: { children: ReactNode }) {
  // Undefined when the root loader failed, null when signed out.
  const session = useRouteLoaderData<Session>('root');

  return (
    <div className="bg-background text-ink min-h-screen font-sans">
      <header className="border-border bg-surface border-b">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link
            to="/"
            className={`rounded-control text-accent text-lg font-semibold ${focusStyle}`}
          >
            SlotDesk
          </Link>
          {session && (
            <div className="flex items-center gap-3">
              <span className="text-muted truncate text-sm">
                {session.user.email}
              </span>
              <Form method="post" action="/sign-out">
                <Button type="submit">Sign out</Button>
              </Form>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>
    </div>
  );
}
