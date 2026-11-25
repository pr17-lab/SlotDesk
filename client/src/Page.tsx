import type { ReactNode } from 'react';
import { Form, Link, useNavigation, useRouteLoaderData } from 'react-router';
import { Button } from '@/components/ui/button';
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
        {/* As wide as the widest page, so it doesn't jump between pages. */}
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link
            to="/"
            className={`text-primary rounded-lg text-lg font-semibold ${focusStyle}`}
          >
            SlotDesk
          </Link>
          {session && (
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-muted-foreground hidden truncate text-sm sm:block">
                {session.user.email}
              </span>
              <Form method="post" action="/sign-out" className="shrink-0">
                <Button type="submit" variant="ghost" size="sm">
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
