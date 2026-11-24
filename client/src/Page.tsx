import type { ReactNode } from 'react';
import { Form, Link, useNavigation, useRouteLoaderData } from 'react-router';
import type { Session } from './session';
import { focusStyle } from './ui';

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
  // 'submitting' is left out: buttons already say "Saving…".
  const loading = useNavigation().state === 'loading';

  return (
    <div className="bg-background text-foreground min-h-screen font-sans">
      {loading && (
        <div
          role="progressbar"
          aria-label="Loading page"
          className="bg-border fixed inset-x-0 top-0 z-30 h-1 overflow-hidden"
        >
          <div className="bg-primary motion-safe:animate-loading h-full w-2/5" />
        </div>
      )}
      <header className="border-border bg-card border-b">
        <div
          className={`mx-auto flex ${width} items-center justify-between gap-4 px-4 py-3 sm:px-6`}
        >
          <Link
            to="/"
            className={`text-primary rounded-lg text-lg font-semibold ${focusStyle}`}
          >
            SlotDesk
          </Link>
          {session && (
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-muted-foreground truncate text-sm">
                {session.user.email}
              </span>
              <Form method="post" action="/sign-out" className="shrink-0">
                <button
                  type="submit"
                  className={`text-primary rounded-lg text-sm whitespace-nowrap underline hover:no-underline ${focusStyle}`}
                >
                  Sign out
                </button>
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
