import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Description,
  Field,
  Label,
} from '@headlessui/react';
import { useState } from 'react';
import { focusStyle } from './ui';

// Browsers still say Asia/Calcutta; the server only knows the new name.
export function toDisplayZone(zone: string) {
  return zone === 'Asia/Calcutta' ? 'Asia/Kolkata' : zone;
}

export function browserTimeZone() {
  return toDisplayZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

// Intl has no plain UTC in its list, so it is added.
const zones = [
  ...new Set([...Intl.supportedValuesOf('timeZone').map(toDisplayZone), 'UTC']),
].sort();

// For display only, like "GMT+05:30".
function offsetOf(zone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date());
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
}

export function TimeZonePicker({ hint }: { hint: string }) {
  const [zone, setZone] = useState(browserTimeZone);
  const [query, setQuery] = useState('');
  const matches = zones
    .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 50);

  return (
    <Field>
      <Label className="block text-sm font-medium">Time zone</Label>
      {/* The Combobox's own name prop adds the hidden timeZone field. */}
      <Combobox
        value={zone}
        onChange={(picked) => picked && setZone(picked)}
        onClose={() => setQuery('')}
        name="timeZone"
      >
        <div className="relative">
          <ComboboxInput
            displayValue={(name: string) => name}
            onChange={(event) => setQuery(event.target.value)}
            className={`border-muted bg-surface text-ink rounded-control mt-1 block w-full border px-3 py-2 ${focusStyle}`}
          />
          <ComboboxOptions className="bg-surface border-border rounded-control absolute z-10 mt-1 max-h-60 w-full overflow-auto border py-1 shadow-md">
            {matches.length === 0 && (
              <p className="text-muted px-3 py-2 text-sm">
                No matching time zone
              </p>
            )}
            {matches.map((name) => (
              <ComboboxOption
                key={name}
                value={name}
                className="data-focus:bg-background flex cursor-pointer items-center justify-between gap-3 px-3 py-2 data-selected:font-semibold"
              >
                <span>{name}</span>
                <span className="text-muted text-sm font-normal">
                  {offsetOf(name)}
                </span>
              </ComboboxOption>
            ))}
          </ComboboxOptions>
        </div>
      </Combobox>
      <Description className="text-muted mt-1 text-sm">{hint}</Description>
    </Field>
  );
}
