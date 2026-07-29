-- Worksheet definitions (specs/modules/pages.md § The worksheet response pattern).
--
-- A worksheet page is published as DATA, not hand-written HTML: the definition
-- (weighable components + their per-basis references + the computed fields)
-- lands here alongside the HTML the module rendered from it. Storing it is what
-- lets an incoming submission be validated against the worksheet it claims to
-- answer, and lets the server — not per-page JS — compute the totals.
--
-- It hangs off `versions`, not `pages`, because a republish is a new version:
-- the definition a submission validates against is the one currently served,
-- and every prior definition is retained exactly like its HTML.
--
-- Additive and nullable: every existing version row (and every future
-- plain-HTML publish) simply carries NULL here.

ALTER TABLE pages.versions
    ADD COLUMN worksheet JSONB;
