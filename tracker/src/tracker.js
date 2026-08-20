/**
 * Implausible tracker.
 *
 * Budget: under 1024 bytes minified, enforced by tracker/build.mjs and CI.
 * Every byte here is spent deliberately — read CONTRIBUTING.md before adding.
 *
 * Collects: domain, pathname, referrer, viewport width. Nothing else.
 * Writes: nothing. No cookies, no storage, no fingerprinting APIs.
 *
 * Usage:
 *   <script defer data-domain="yoursite.com" src="https://host/i.js"></script>
 */
(function (win, doc, nav) {
  var el = doc.currentScript;
  var domain = el.getAttribute('data-domain') || location.hostname;
  var api = el.getAttribute('data-api') || new URL(el.src).origin + '/api/event';
  var hist = win.history;
  var last;

  function send() {
    var path = location.pathname;
    // Guard against SPA frameworks that fire a route change per render.
    if (path === last) return;
    last = path;

    // A plain string body stays a CORS-simple request: no preflight, so a
    // single POST leaves the browser. The server parses it as JSON regardless
    // of the text/plain content type the browser attaches.
    var body = JSON.stringify({
      domain: domain,
      pathname: path,
      referrer: doc.referrer || null,
      screen_width: win.innerWidth,
    });

    if (!(nav.sendBeacon && nav.sendBeacon(api, body))) {
      fetch(api, { method: 'POST', body: body, keepalive: true });
    }
  }

  function start() {
    var push = hist.pushState;
    if (push) {
      hist.pushState = function () {
        push.apply(this, arguments);
        send();
      };
      win.addEventListener('popstate', send);
    }
    send();
  }

  // A prerendered page is not a pageview until it is actually shown.
  if (doc.visibilityState === 'prerender') {
    doc.addEventListener('visibilitychange', function () {
      if (!last && doc.visibilityState === 'visible') start();
    });
  } else {
    start();
  }
})(window, document, navigator);
