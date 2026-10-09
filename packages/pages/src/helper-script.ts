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
            // Surface the server's own \`error\` line when there is one — a
            // failure panel showing raw JSON tells the reader nothing.
            var detail = text;
            var parsed = null;
            try {
              parsed = JSON.parse(text);
              if (parsed && parsed.error) detail = parsed.error;
            } catch (e) {
              /* not JSON — use the body verbatim */
            }
            var error = new Error(
              'Request failed (HTTP ' + res.status + ')' + (detail ? ': ' + detail : '')
            );
            // The worksheet runtime tells a 409 (the key already means
            // something else — mint a fresh one) from a 502 (retry the same
            // key) by status, so it rides on the error.
            error.status = res.status;
            error.body = parsed;
            throw error;
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

  // ── Worksheet runtime (§ The worksheet response pattern) ───────────────────
  //
  // Drives the ONE canonical worksheet document rendered by
  // renderWorksheetHtml: live totals, a durable submission key, an explicit
  // confirmation, and a retry that is safe because it reuses that key. The
  // arithmetic here mirrors computeWorksheetTotals — for DISPLAY only. The
  // server recomputes from the published definition and its numbers are the
  // ones stored, so a tampered or stale client cannot bend what gets recorded.

  function ulid() {
    var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    var ms = Date.now();
    var out = '';
    for (var i = 0; i < 10; i++) {
      out = ALPHABET.charAt(ms % 32) + out;
      ms = Math.floor(ms / 32);
    }
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var k = 0; k < 16; k++) bytes[k] = Math.floor(Math.random() * 256);
    }
    for (var j = 0; j < 16; j++) out += ALPHABET.charAt(bytes[j] % 32);
    return out.slice(0, 26);
  }

  // Scoped to (slug, instance) rather than slug alone: the same slug's HTML
  // is re-rendered on every publish, and each render carries a fresh
  // \`data-pw-instance\` token (worksheet.ts renderInstanceToken). Keying on
  // that too means a republish — which is how a sheet gets corrected — always
  // starts a fresh submission, while a reload of the SAME rendered page still
  // finds its draft and retries the SAME submission key. Without the
  // instance, a republished sheet would come up pre-filled with the prior
  // run's quantities and reuse its submission_key, so the next submit is
  // treated as an idempotent replay and writes nothing while still showing
  // "✓ Recorded".
  function draftKey(slug, instance) {
    return 'pages-worksheet:' + slug + ':' + instance;
  }

  function readDraft(slug, instance) {
    try {
      return JSON.parse(window.localStorage.getItem(draftKey(slug, instance)) || 'null') || null;
    } catch (e) {
      return null;
    }
  }

  function writeDraft(slug, instance, draft) {
    try {
      window.localStorage.setItem(draftKey(slug, instance), JSON.stringify(draft));
    } catch (e) {
      /* private mode / quota — the worksheet still works, it just won't survive a reload */
    }
  }

  function removeDraft(slug, instance) {
    try {
      window.localStorage.removeItem(draftKey(slug, instance));
    } catch (e) {
      /* same — nothing to clear is the same as cleared */
    }
  }

  function pagesWorksheetInit() {
    var node = document.getElementById('pw-definition');
    if (!node) return;
    var def = JSON.parse(node.textContent);
    var slug = currentSlug() || 'unknown';
    // Falls back to a fixed label rather than the slug alone when a page
    // rendered before this instance token existed is still being served —
    // that just means its one in-flight draft (if any) won't be found under
    // the new key, which is the same as a reload after clearing storage.
    var instance = node.getAttribute('data-pw-instance') || 'legacy';
    var basis = def.basis || 100;
    var inputs = [].slice.call(document.querySelectorAll('[data-pw-label]'));
    var statusEl = document.getElementById('pw-status');
    var submitEl = document.getElementById('pw-submit');
    var noteEl = document.getElementById('pw-note');
    var restoreEl = document.getElementById('pw-restore');

    // The submission key is minted PER SUBMISSION, at submit time, and lives
    // in the draft only while that submission is PENDING — minted and not yet
    // confirmed. A page that comes back after the network dropped must retry
    // the SAME submission, not open a second one, so a pending key survives a
    // reload of the same published instance. Once the server confirms the
    // write the key is retired from the draft: the next submit, whether a tap
    // of "Submit again" now or a reload tomorrow for tomorrow's weights, is a
    // second real event and mints a fresh key. A key that outlived its
    // submission made the second meal dedupe as a replay of the first — no
    // entry, no decrement, a green check (§ Idempotency).
    var draft = readDraft(slug, instance) || {};
    var pending = draft.submission_key || null;

    function saveDraft() {
      var next = { quantities: quantities() };
      if (pending) next.submission_key = pending;
      writeDraft(slug, instance, next);
    }

    function quantities() {
      return inputs.map(function (input) {
        var value = parseFloat(input.value);
        return {
          label: input.getAttribute('data-pw-label'),
          quantity: isFinite(value) && value >= 0 ? value : 0,
        };
      });
    }

    function recompute() {
      var stated = {};
      quantities().forEach(function (q) {
        stated[q.label] = q.quantity;
      });
      var sums = {};
      def.components.forEach(function (component) {
        var qty = stated[component.label];
        if (qty === undefined) qty = component.quantity;
        var factor = qty / basis;
        Object.keys(component.per_basis).forEach(function (fieldKey) {
          sums[fieldKey] = (sums[fieldKey] || 0) + component.per_basis[fieldKey] * factor;
        });
      });
      def.fields.forEach(function (field) {
        var cell = document.querySelector('[data-pw-total="' + field.key + '"]');
        if (!cell) return;
        var sum = sums[field.key];
        var precision = field.precision === undefined ? 1 : field.precision;
        cell.textContent = sum === undefined ? '—' : sum.toFixed(precision);
      });
    }

    function setStatus(state, headline, detail, buttonLabel) {
      statusEl.setAttribute('data-state', state);
      statusEl.textContent = '';
      var h = document.createElement('h2');
      h.textContent = headline;
      statusEl.appendChild(h);
      (detail || []).forEach(function (line) {
        var p = document.createElement('p');
        p.textContent = line;
        statusEl.appendChild(p);
      });
      if (buttonLabel) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = buttonLabel;
        button.addEventListener('click', submit);
        statusEl.appendChild(button);
      }
    }

    // "Calories 363, Protein 8.4 g" — the totals the server actually stored,
    // named by the sheet's own fields.
    function describeTotals(totals) {
      if (!totals) return '';
      return def.fields
        .map(function (field) {
          var value = totals[field.key];
          return field.label + ' ' + (value === null || value === undefined ? '—' : value) + (field.unit ? ' ' + field.unit : '');
        })
        .join(', ');
    }

    // One line per decrement the write applied, and one per decrement it did
    // NOT apply with the reason — on the page, where the person who can fix a
    // missing net weight is standing. A refusal that lived only in the entry
    // note was recorded honestly and seen by nobody.
    function describeDecrements(decrements) {
      if (!decrements) return [];
      var lines = [];
      (decrements.applied || []).forEach(function (d) {
        lines.push('− ' + d.quantity + ' ' + d.unit + ' ' + d.component + ' (item ' + d.item_ulid + ')');
      });
      (decrements.unapplied || []).forEach(function (d) {
        lines.push(
          '⚠ ' + d.component + ' NOT decremented' +
            (d.quantity !== null && d.quantity !== undefined ? ' (' + d.quantity + ')' : '') +
            (d.item_ulid ? ' (item ' + d.item_ulid + ')' : '') +
            ': ' + d.reason
        );
      });
      if (lines.length === 0) {
        lines.push('No stock was decremented — no component on this sheet is bound to an item.');
      }
      return lines;
    }

    function describe(cook, totals) {
      if (!cook) return ['Recorded in this page\\'s response queue.'];
      var name = cook.label ? '"' + cook.label + '"' : 'it';
      var summary = describeTotals(totals);
      if (cook.status === 'logged') {
        var head =
          cook.kind === 'entry'
            ? 'Logged ' + name + ' to the journal' + (summary ? ' — ' + summary : '') + ' (entry ' + cook.ulid + ').'
            : 'Recorded ' + name + ' as prepped stock' + (summary ? ' — ' + summary : '') + ' (item ' + cook.ulid + ').';
        return [head].concat(describeDecrements(cook.decrements));
      }
      if (cook.status === 'already-logged') {
        return [
          'Already recorded earlier — nothing was written twice (' + cook.ulid + ').',
        ].concat(cook.decrements ? describeDecrements(cook.decrements) : []);
      }
      return ['The journal write did NOT happen.'];
    }

    function submit() {
      // A pending key is a retry after a failure — one event, twice attempted.
      // No pending key means this is a new submission, and it gets its own.
      var key = pending || ulid();
      pending = key;
      submitEl.disabled = true;
      setStatus('busy', 'Submitting…', ['Do not close this page yet.']);
      var payload = {
        kind: 'worksheet',
        version: def.version,
        submission_key: key,
        quantities: quantities(),
        note: (noteEl && noteEl.value) || undefined,
      };
      saveDraft();

      pagesRespond(payload)
        .then(function (result) {
          var cook = (result && result.worksheet && result.worksheet.cook_mode) || null;
          var totals = (result && result.worksheet && result.worksheet.totals) || null;
          // Confirmed: the key has done its one job and is retired. The draft
          // goes with it — the numbers are on the server now, and the restore
          // affordance reads them back from there (§ Interaction with the
          // restore affordance) rather than offering them as "unsent".
          pending = null;
          removeDraft(slug, instance);
          setStatus('ok', '✓ Recorded', describe(cook, totals).concat(['Your submitted numbers are saved.']));
          submitEl.textContent = 'Submit again';
          submitEl.disabled = false;
        })
        .catch(function (error) {
          if (error && error.status === 409) {
            // The key already means something else (a stale draft, typically:
            // yesterday's confirmed key on a page reloaded today). Nothing was
            // written. Drop the key, keep the numbers, and make the next tap a
            // NEW submission rather than a retry of this one.
            pending = null;
            saveDraft();
            setStatus(
              'error',
              '✗ Not recorded',
              [
                String((error && error.message) || error),
                'Nothing was written. Your numbers are still here — tap "Submit as new" to record them as a new entry.',
              ],
              'Submit as new'
            );
            submitEl.disabled = false;
            return;
          }
          setStatus(
            'error',
            '✗ Not recorded',
            [
              String((error && error.message) || error),
              'Your numbers are still here. Retrying is safe — it cannot double-log.',
            ],
            'Retry'
          );
          submitEl.disabled = false;
        });
    }

    inputs.forEach(function (input) {
      input.addEventListener('input', function () {
        recompute();
        saveDraft();
      });
    });
    if (submitEl) submitEl.addEventListener('click', submit);

    // Restore affordance (§ Responses): never silently overwrite what the
    // visitor is looking at — offer it, let them choose.
    function offerRestore(label, values) {
      if (!restoreEl) return;
      restoreEl.hidden = false;
      restoreEl.textContent = '';
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', function () {
        inputs.forEach(function (input) {
          var value = values[input.getAttribute('data-pw-label')];
          if (value !== undefined) input.value = value;
        });
        recompute();
        restoreEl.hidden = true;
      });
      restoreEl.appendChild(button);
    }

    recompute();

    if (draft.quantities && draft.quantities.length) {
      var local = {};
      draft.quantities.forEach(function (q) {
        local[q.label] = q.quantity;
      });
      offerRestore('Restore your unsent entries', local);
    } else {
      pagesLastResponse().then(function (last) {
        if (!last || !last.payload || last.payload.kind !== 'worksheet') return;
        if (!last.payload.components) return;
        var previous = {};
        last.payload.components.forEach(function (c) {
          previous[c.label] = c.quantity;
        });
        offerRestore('Restore the last submitted entries', previous);
      });
    }
  }

  window.pagesRespond = pagesRespond;
  window.pagesLastResponse = pagesLastResponse;
  window.pagesWorksheetInit = pagesWorksheetInit;
})();
`;
