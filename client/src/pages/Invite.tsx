import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Page } from '../Page';
import { Card, focusStyle } from '../ui';

// The secret from an invite link waits here while the person signs in. Kept
// for this tab only, and cleared once they accept or decline.
const KEY = 'slotdesk.invite';

// Storage can throw (blocked by the browser), so every use is guarded.
export function keptInviteToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetInviteToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing was kept.
  }
}

// /invite#<secret>. The part after # never reaches a server, so the secret
// isn't in any request log. We keep it, then replace the address so it
// leaves the address bar and the history too. The home page takes it from
// there, after sign-in if needed.
export function Invite() {
  const { hash, state } = useLocation();
  const navigate = useNavigate();
  const blocked = (state as { blocked?: boolean } | null)?.blocked === true;

  useEffect(() => {
    if (blocked) return;
    const token = hash.slice(1);
    try {
      if (token) sessionStorage.setItem(KEY, token);
    } catch {
      // Still take the secret out of the address.
      navigate('/invite', { replace: true, state: { blocked: true } });
      return;
    }
    navigate('/', { replace: true });
  }, [blocked, hash, navigate]);

  if (!blocked) return null;
  return (
    <Page>
      <Card title="Invite link">
        <p className="mt-2">
          This browser didn&apos;t let us keep the invite. Sign in first, then
          open the link again.
        </p>
        <Link
          to="/"
          className={`text-primary mt-4 inline-block rounded-lg font-medium hover:underline ${focusStyle}`}
        >
          Go to sign in
        </Link>
      </Card>
    </Page>
  );
}
