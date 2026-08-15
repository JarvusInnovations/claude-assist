-- Page titles were stored still HTML-ENCODED.
--
-- `extractHtmlTitle` lifted the raw text of an authored `<title>` element, which
-- is encoded by definition, and stored it verbatim. The title is then consumed
-- as PLAIN TEXT everywhere except the page itself — the JSON index, the CLI
-- table, notification bodies — so a page called "Rotini, Sardines & Feta"
-- rendered as "Rotini, Sardines &amp; Feta" in front of every reader.
--
-- The extraction now decodes (see src/axi/index.ts), and the HTML renderer
-- escapes on output, so text is stored plain and encoded exactly once at the
-- boundary that needs it. This repairs rows written before that.
--
-- Scope: the five XML predefined entities and nothing else. A general HTML
-- decode in SQL would be both wrong and dangerous; numeric references are left
-- alone rather than guessed at, since they are vanishingly rare in a title and a
-- visible `&#8212;` is a better outcome than a bad substitution.
--
-- Ampersand is decoded LAST. Decoding it first would turn a legitimately
-- double-encoded `&amp;lt;` into `<`, inventing markup out of text.

UPDATE pages.pages
SET title = replace(
              replace(
                replace(
                  replace(
                    replace(title, '&lt;', '<'),
                  '&gt;', '>'),
                '&quot;', '"'),
              '&#39;', ''''),
            '&amp;', '&')
WHERE title LIKE '%&lt;%'
   OR title LIKE '%&gt;%'
   OR title LIKE '%&quot;%'
   OR title LIKE '%&#39;%'
   OR title LIKE '%&amp;%';
