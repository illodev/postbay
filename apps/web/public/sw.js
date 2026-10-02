// Shows push messages from the studio and opens the right page when one is clicked. The message is JSON the studio's server made:
// { title, body, url, tag }. It is encrypted for this browser, so only this browser ever reads it.
// Served from the root of the site so it controls every page; it never touches the network or caches anything.

/** A page of this site only: a message cannot send a click anywhere else. */
function pageOnThisSite(url) {
  if (typeof url !== 'string' || !url) return '/';
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Content Studio';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    data: { url: pageOnThisSite(typeof data.url === 'string' ? data.url : '/') },
  };
  // The same tag replaces the earlier message about the same thing instead of piling up beside it.
  if (typeof data.tag === 'string' && data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = pageOnThisSite(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w && new URL(w.url).origin === self.location.origin) {
          return w.focus().then((f) => (f && 'navigate' in f ? f.navigate(url) : undefined));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
