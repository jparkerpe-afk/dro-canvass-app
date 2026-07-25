const swStatusEl = document.getElementById('sw-status');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js')
    .then(() => {
      swStatusEl.textContent = 'Service worker: registered';
    })
    .catch((err) => {
      swStatusEl.textContent = 'Service worker: failed to register';
      console.error('Service worker registration failed', err);
    });
} else {
  swStatusEl.textContent = 'Service worker: not supported in this browser';
}
