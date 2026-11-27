// The cancel link a customer gets after booking online.

// Online cancelling closes this long before the start. The server decides;
// the page only uses it to choose what to show.
export const CANCEL_NOTICE_HOURS = 24;

// 32 bytes from the browser's cryptographic random source, as 43 base64url
// characters with no padding: the format the server checks.
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// The part after # never reaches a server, so the secret is in no request
// log and no Referer header.
export const cancelLink = (secret: string) =>
  `${window.location.origin}/manage#${secret}`;
