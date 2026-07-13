/**
 * The response-helper JS served at GET /pages/_helper.js. Pages include it
 * with `<script src="/pages/_helper.js"></script>` and then call
 * `window.pagesRespond(payload, { anchor, note })` to post a structured
 * response back to the page it's embedded in.
 *
 * `window.pagesLastResponse()` is the read-back counterpart: it resolves to
 * the most recent response this page has recorded (or `null` if none), so a
 * page can restore its last submission on reload. Convention: pages that
 * collect submissions SHOULD call `pagesLastResponse()` on load and offer a
 * restore affordance (e.g. pre-filling the form, or a "restore previous
 * answer" prompt) built from the result. Errors resolve to `null` rather
 * than rejecting — a restore affordance must never break the page.
 *
 * The current slug is inferred from `location.pathname` (`/pages/<slug>...`)
 * rather than injected at serve time, so GET /pages/:slug can return the
 * published HTML byte-for-byte unmodified.
 */
export const HELPER_SCRIPT = `(function () {
  function currentSlug() {
    var match = window.location.pathname.match(/\\/pages\\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function pagesRespond(payload, options) {
    options = options || {};
    var slug = currentSlug();
    if (!slug) {
      return Promise.reject(
        new Error('pagesRespond: could not determine the page slug from the URL')
      );
    }
    return fetch('/api/pages/' + encodeURIComponent(slug) + '/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: payload,
        anchor: options.anchor,
        note: options.note,
      }),
    }).then(function (res) {
      if (!res.ok) {
        return res
          .text()
          .catch(function () {
            return '';
          })
          .then(function (text) {
            throw new Error(
              'pagesRespond: request failed with status ' + res.status + (text ? ': ' + text : '')
            );
          });
      }
      return res.json();
    });
  }

  function pagesLastResponse() {
    var slug = currentSlug();
    if (!slug) {
      return Promise.resolve(null);
    }
    return fetch('/api/pages/' + encodeURIComponent(slug) + '/responses?latest=1')
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (json) {
        if (!json || !json.responses || json.responses.length === 0) return null;
        return json.responses[0];
      })
      .catch(function () {
        return null;
      });
  }

  window.pagesRespond = pagesRespond;
  window.pagesLastResponse = pagesLastResponse;
})();
`;
