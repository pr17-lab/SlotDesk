import { useId, type ComponentProps } from 'react';

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
