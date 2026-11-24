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
  'focus-visible:outline-primary focus-visible:outline-2 focus-visible:outline-offset-2';

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
        className={`border-input bg-card text-foreground mt-1 block w-full rounded-lg border px-3 py-2 ${focusStyle}`}
        {...inputProps}
      />
      {hint && (
        <p id={hintId} className="text-muted-foreground mt-1 text-sm">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Button({ className = '', ...props }: ComponentProps<'button'>) {
  return (
    <button
      className={`bg-primary text-primary-foreground rounded-lg px-4 py-2 font-medium disabled:opacity-60 ${focusStyle} ${className}`}
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
      className="bg-card border-border rounded-lg border p-5 shadow-sm"
    >
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const badgeTones = {
  neutral: 'border-border bg-background text-muted-foreground',
  accent: 'border-primary/30 bg-primary/10 text-primary',
};

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: keyof typeof badgeTones;
}) {
  return (
    <span
      className={`${badgeTones[tone]} rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap`}
    >
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
    <li className="hover:bg-background relative -mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-3 transition-colors">
      {to ? (
        <Link
          to={to}
          className={`text-primary rounded-lg font-medium after:absolute after:inset-0 hover:underline ${focusStyle}`}
        >
          {name}
        </Link>
      ) : (
        <span className="font-medium">{name}</span>
      )}
      <span className="text-muted-foreground flex items-center gap-2 text-sm">
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
      <DialogBackdrop className="bg-foreground/40 fixed inset-0" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="bg-card border-border w-full max-w-md rounded-lg border p-5 shadow-lg">
          <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          {children}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

const secondaryStyle = `border-input bg-card text-foreground rounded-lg hover:bg-background border font-medium transition-colors ${focusStyle}`;

// `small` is the compact size used in rows and toolbars.
const secondarySize = (small: boolean) =>
  small ? 'px-3 py-1.5 text-sm' : 'px-4 py-2';

export function SecondaryButton({
  className = '',
  small = false,
  ...props
}: ComponentProps<'button'> & { small?: boolean }) {
  return (
    <button
      className={`${secondaryStyle} ${secondarySize(small)} ${className}`}
      {...props}
    />
  );
}

export function SecondaryLink({
  className = '',
  small = false,
  ...props
}: ComponentProps<typeof Link> & { small?: boolean }) {
  return (
    <Link
      className={`${secondaryStyle} ${secondarySize(small)} ${className}`}
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
    <nav aria-label="Breadcrumb" className="text-muted-foreground text-sm">
      <ol className="flex flex-wrap items-center gap-x-2">
        {items.map((item, index) => (
          <li key={item.label} className="flex items-center gap-x-2">
            {index > 0 && <span aria-hidden="true">›</span>}
            {item.to ? (
              <Link
                to={item.to}
                className={`rounded-lg hover:underline ${focusStyle}`}
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
      <p role="alert" className="text-destructive text-sm">
        {result.error}
      </p>
    );
  }
  if (result?.notice) {
    return (
      <p
        role="status"
        className="bg-primary/10 text-primary motion-safe:animate-fade-in mt-3 rounded-lg px-3 py-2 text-sm font-medium"
      >
        {result.notice}
      </p>
    );
  }
  return null;
}
