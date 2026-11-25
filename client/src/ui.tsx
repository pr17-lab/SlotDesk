import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Org } from './api';
import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

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
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-describedby={hint ? hintId : undefined}
        className="mt-1"
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
      className="bg-card border-border rounded-lg border p-4 shadow-sm sm:p-5"
    >
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

// Sign-in and sign-up: one centred card under a line on what SlotDesk is for.
export function AuthCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-sm">
      <p className="text-muted-foreground text-center">
        Booking slots for small clinics and studios
      </p>
      <section className="bg-card border-border mt-4 rounded-lg border p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {children}
      </section>
    </div>
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
    <ShadcnBadge variant="outline" className={badgeTones[tone]}>
      {children}
    </ShadcnBadge>
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

// A dialog with a dimmed page behind it. A close (Escape, the backdrop, a
// DialogClose button) finishes first; only then does the parent unmount it.
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  // Opened without a trigger, so focus goes back to what had it before. The
  // cast is because activeElement is typed as a plain Element.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => !isOpen && onClose()}
    >
      <DialogContent
        showCloseButton={false}
        finalFocus={() => opener}
        className="block"
      >
        <DialogTitle className="text-lg leading-snug font-semibold">
          {title}
        </DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

// The outline button with our darker input border, so it stands out on a white card.
// `small` is the compact size used in rows and toolbars.
const secondarySize = (small: boolean) => (small ? 'sm' : 'default');

export function SecondaryButton({
  className,
  small = false,
  ...props
}: ComponentProps<typeof Button> & { small?: boolean }) {
  return (
    <Button
      variant="outline"
      size={secondarySize(small)}
      className={cn('border-input', className)}
      {...props}
    />
  );
}

export function SecondaryLink({
  className,
  small = false,
  ...props
}: ComponentProps<typeof Link> & { small?: boolean }) {
  return (
    <Link
      className={cn(
        buttonVariants({ variant: 'outline', size: secondarySize(small) }),
        'border-input',
        className,
      )}
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
