import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from '@headlessui/react';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Org } from './api';

// One focus look for every link, button and field.
export const focusStyle =
  'focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2';

type TextFieldProps = ComponentProps<'input'> & {
  label: string;
  hint?: string;
};

export function TextField({ label, hint, ...inputProps }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hint ? hintId : undefined}
        className={`border-muted bg-surface text-ink rounded-control mt-1 block w-full border px-3 py-2 ${focusStyle}`}
        {...inputProps}
      />
      {hint && (
        <p id={hintId} className="text-muted mt-1 text-sm">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Button({ className = '', ...props }: ComponentProps<'button'>) {
  return (
    <button
      className={`bg-accent text-accent-ink rounded-control px-4 py-2 font-medium disabled:opacity-60 ${focusStyle} ${className}`}
      {...props}
    />
  );
}

export function Card({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const id = useId();

  return (
    <section
      aria-labelledby={id}
      className="bg-surface border-border rounded-control border p-5 shadow-sm"
    >
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="border-border bg-background text-muted rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
      {children}
    </span>
  );
}

export function RoleBadge({ role }: { role: Org['role'] }) {
  return <Badge>{role === 'owner' ? 'Owner' : 'Staff'}</Badge>;
}

// One row of a list inside a card. With `to` the name is a link, and the
// link's click area covers the whole row.
export function ListRow({
  to,
  name,
  detail,
}: {
  to?: string;
  name: string;
  detail: ReactNode;
}) {
  return (
    <li className="hover:bg-background rounded-control relative -mx-2 flex items-center justify-between gap-3 px-2 py-3 transition-colors">
      {to ? (
        <Link
          to={to}
          className={`rounded-control text-accent font-medium after:absolute after:inset-0 hover:underline ${focusStyle}`}
        >
          {name}
        </Link>
      ) : (
        <span className="font-medium">{name}</span>
      )}
      <span className="text-muted flex items-center gap-2 text-sm">
        {detail}
        {to && <span aria-hidden="true">›</span>}
      </span>
    </li>
  );
}

// A dialog with a dimmed page behind it. Headless UI traps focus inside and
// closes it on Escape.
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onClose={onClose} className="relative z-20">
      <DialogBackdrop className="bg-ink/40 fixed inset-0" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="bg-surface border-border rounded-control w-full max-w-md border p-5 shadow-lg">
          <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          {children}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

export function SecondaryButton({
  className = '',
  ...props
}: ComponentProps<'button'>) {
  return (
    <button
      className={`border-muted bg-surface text-ink rounded-control border px-4 py-2 font-medium ${focusStyle} ${className}`}
      {...props}
    />
  );
}

export function Breadcrumb({
  items,
}: {
  items: { label: string; to?: string }[];
}) {
  return (
    <nav aria-label="Breadcrumb" className="text-muted text-sm">
      <ol className="flex flex-wrap items-center gap-x-2">
        {items.map((item, index) => (
          <li key={item.label} className="flex items-center gap-x-2">
            {index > 0 && <span aria-hidden="true">›</span>}
            {item.to ? (
              <Link
                to={item.to}
                className={`rounded-control hover:underline ${focusStyle}`}
              >
                {item.label}
              </Link>
            ) : (
              <span aria-current="page">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// What a form's action answered: an error under the form, or a success note.
export function FormMessage({
  result,
}: {
  result: { error?: string; notice?: string } | null | undefined;
}) {
  if (result?.error) {
    return (
      <p role="alert" className="text-danger text-sm">
        {result.error}
      </p>
    );
  }
  if (result?.notice) {
    return (
      <p role="status" className="text-accent text-sm font-medium">
        {result.notice}
      </p>
    );
  }
  return null;
}
