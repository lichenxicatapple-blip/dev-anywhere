self.addEventListener("notificationclick", (event) => {
  const targetUrl = event.notification.data?.url;
  event.notification.close();
  if (typeof targetUrl !== "string" || !targetUrl) return;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windowClients) => {
        const targetOrigin = new URL(targetUrl).origin;
        const existing = windowClients.find(
          (client) => new URL(client.url).origin === targetOrigin,
        );
        if (existing) {
          await existing.navigate(targetUrl);
          return existing.focus();
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
