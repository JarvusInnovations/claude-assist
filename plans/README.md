# Plans

Work-in-flight DAG bridging `specs/` to merged code — motion, where specs are
state. One file per chunk of work; frontmatter (`status`, `depends`, `specs`)
is the authoritative graph (query it with the specops CLI; no hand-drawn
tables here — they rot). Full protocol: the vendored specops skill
(`.agents/skills/specops/`), references/plans-protocol.md.
