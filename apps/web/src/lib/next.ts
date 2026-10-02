/**
 * Where to go back to once signed in. Only the consent page of an assistant uses it: a person who opens it signed out goes through the
 * sign-in (link, single sign-on, development sign-in, second factor), lands on the app, and is sent back to it. Kept for a few minutes,
 * in this browser only, and only ever a path of that page, so nothing else can use it to send someone elsewhere.
 */
const KEY = 'postbay.next';
const MAX_AGE_MS = 15 * 60_000;
const ALLOWED = /^\/oauth\/consent\?[\w=&%.-]*$/;

export function rememberNext(path: string): void {
  if (!ALLOWED.test(path)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch { /* private mode: the person opens the link again */ }
}

export function takeNext(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const v = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof v.path !== 'string' || !ALLOWED.test(v.path) || typeof v.at !== 'number' || Date.now() - v.at > MAX_AGE_MS) return null;
    return v.path;
  } catch {
    return null;
  }
}
