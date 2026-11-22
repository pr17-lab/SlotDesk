import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background text-ink min-h-screen font-sans">
      <header className="border-border bg-surface border-b">
        <div className="mx-auto max-w-2xl px-4 py-3 sm:px-6">
          <Link
            to="/"
            className="rounded-control text-accent focus-visible:outline-accent text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            SlotDesk
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>
    </div>
  );
}
