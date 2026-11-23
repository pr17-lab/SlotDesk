import type { ReactNode } from 'react';
import { Form, Link, useRouteLoaderData } from 'react-router';
import type { Session } from './session';
import { Button, focusStyle } from './ui';

export function Page({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  const width = wide ? 'max-w-4xl' : 'max-w-2xl';
  // Undefined when the root loader failed, null when signed out.
  const session = useRouteLoaderData<Session>('root');

  return (
    <div className="bg-background text-ink min-h-screen font-sans">
      <header className="border-border bg-surface border-b">
        <div
          className={`mx-auto flex ${width} items-center justify-between gap-4 px-4 py-3 sm:px-6`}
        >
          <Link
            to="/"
            className={`rounded-control text-accent text-lg font-semibold ${focusStyle}`}
          >
            SlotDesk
          </Link>
          {session && (
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-muted truncate text-sm">
                {session.user.email}
              </span>
              <Form method="post" action="/sign-out" className="shrink-0">
                <Button type="submit" className="whitespace-nowrap">
                  Sign out
                </Button>
              </Form>
            </div>
          )}
        </div>
      </header>
      <main className={`mx-auto ${width} px-4 py-8 sm:px-6 sm:py-12`}>
        {children}
      </main>
    </div>
  );
}
