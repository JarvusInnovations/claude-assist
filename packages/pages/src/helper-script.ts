/**
 * The response-helper JS served at GET /pages/_helper.js. Pages include it
 * with `<script src="/pages/_helper.js"></script>` and then call
 * `window.pagesRespond(payload, { anchor, note })` to post a structured
 * response back to the page it's embedded in.
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

  window.pagesRespond = pagesRespond;
})();
`;
