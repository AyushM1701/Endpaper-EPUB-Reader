/* Service worker registration and update prompt. Kept out of index.html so the
   Content-Security-Policy can forbid inline scripts. */
if ('serviceWorker' in navigator) {
  let refreshing = false;
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // clients.claim() also fires during the first install. There is no old
    // application shell to replace in that case, so avoid a surprise reload.
    if (!hadController) {
      hadController = true;
      return;
    }
    if (refreshing) return;
    refreshing = true;
    if (document.body.classList.contains('reader-active')) {
      window.__reloadAfterReader = true;
    } else {
      window.location.reload();
    }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      const announce = () => {
        if (!reg.waiting) return;
        window.__pendingServiceWorker = reg.waiting;
        if (!document.body.classList.contains('reader-active')) document.getElementById('update-banner')?.removeAttribute('hidden');
      };
      announce();
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) announce();
        });
      });
      reg.update().catch(() => {});
    }).catch(err => console.error('SW registration failed:', err));
  });
}
