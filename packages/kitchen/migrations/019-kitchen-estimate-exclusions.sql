-- Kitchen Module: the estimator's non-food exclusion report
-- (specs/modules/kitchen.md § Billing artifacts are not ingredients).
--
-- When the estimator reads a receipt or a delivery order, the money lines print
-- in the same list as the items: delivery fee, service fee, tip, bag fee, tax,
-- bottle deposit, promo credit, rounding. Estimated as food they invent calories
-- out of a service charge, and a signed credit line can subtract real food from
-- a day's total — an error in the direction that reads as better eating and so
-- never gets questioned.
--
-- The prompt now tells the model to exclude them and report each one. This
-- column is where that report lands, because an exclusion is a JUDGEMENT about
-- the source text and a judgement nobody can see is one nobody can correct. It
-- is also the only way an over-eager exclusion becomes visible: a real food line
-- reported as a `fee` is a bug you can read off the entry, whereas silently
-- dropping it just makes the meal smaller for no stated reason.
--
-- [{text, kind}], kind ∈ fee|tax|tip|deposit|discount|adjustment|other. NULL
-- for every entry that was never model-estimated and for every estimate that
-- excluded nothing — the overwhelming majority, since an ordinary meal photo has
-- no billing lines at all. Additive and nullable: every pre-existing row is
-- correct as it stands.

ALTER TABLE kitchen.entries
    ADD COLUMN IF NOT EXISTS excluded_lines JSONB;
