-- Store aliases: raw store string -> the resolved store it belongs to.
--
-- The receipt parser now resolves a merchant against the roster of known stores
-- (§ Receipt-line matching), but nothing recorded the answer, so the same raw
-- string was re-resolved on every receipt. Two costs: a model call that need not
-- happen, and non-determinism — the same string could resolve differently on two
-- runs, re-fragmenting what the roster exists to unify.
--
-- Recording it makes the resolution a FACT rather than a recomputation.

CREATE TABLE kitchen.store_aliases (
    raw_store       TEXT PRIMARY KEY,
    resolved_store  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE kitchen.store_aliases IS
    'raw store string as it arrived -> the store it resolves to. Written when a receipt resolves a merchant; read to skip re-resolving a string already seen.';

-- An identity row is meaningful: it records that a string WAS resolved and
-- resolved to itself, which is different from never having been seen.
CREATE INDEX idx_store_aliases_resolved ON kitchen.store_aliases (resolved_store);
