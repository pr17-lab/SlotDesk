import { useId, useState } from 'react';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';

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
  const id = useId();
  const [zone, setZone] = useState<string | null>(browserTimeZone);

  return (
    <div>
      <Label htmlFor={id}>Time zone</Label>
      {/* The Combobox's own name prop adds the hidden timeZone field. */}
      <Combobox
        items={zones}
        value={zone}
        onValueChange={(picked) => picked && setZone(picked)}
        name="timeZone"
        limit={50}
      >
        <ComboboxInput
          id={id}
          className="mt-1 w-full"
          aria-describedby={`${id}-hint`}
        />
        <ComboboxContent>
          <ComboboxEmpty>No matching time zone</ComboboxEmpty>
          <ComboboxList>
            {(name: string) => (
              <ComboboxItem key={name} value={name}>
                <span>{name}</span>
                <span className="text-muted-foreground ml-auto text-sm">
                  {offsetOf(name)}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <p id={`${id}-hint`} className="text-muted-foreground mt-1 text-sm">
        {hint}
      </p>
    </div>
  );
}
