// A steady tick for public/js/background.js: timers in a worker keep their
// pace when the page is in a background tab (the page's own slow down to
// once a second). postMessage(ms) starts ticking every `ms`, 0 stops.
let timer = null;
self.onmessage = (e) => {
  clearInterval(timer);
  timer = e.data ? setInterval(() => self.postMessage(0), e.data) : null;
};
