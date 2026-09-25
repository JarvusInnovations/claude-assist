-- transcript_hash becomes a content-version token for chunked sessions
-- (specs/behaviors/session-transcript-storage.md): md5 of
-- '<ingested_bytes>:<last chunk content_hash>', matching
-- transcriptVersionToken() in packages/sessions/src/chunked-ingest.ts.
--
-- Chunked ingest had left transcript_hash frozen, so the outline and
-- classification sweeps (which select sessions whose markers differ from
-- transcript_hash) stopped noticing growth. This recomputes the token for every
-- session and carries each "already processed" marker forward when it was
-- current against the old value, so switching token formats does not by itself
-- mark every session as changed and trigger a full reprocess.
--
-- Markers that were already stale stay stale. A session that grew while the
-- hash was frozen was not detected by this migration; an operator can reset its
-- markers (outline_hash, classification cursor last_hash) to reprocess it.

-- Cursors first, while sessions.transcript_hash still holds the old value.
UPDATE sessions.classification_cursors c
SET last_hash = md5(s.ingested_bytes::text || ':' || lc.content_hash)
FROM sessions.sessions s
JOIN LATERAL (
  SELECT content_hash FROM sessions.transcript_chunks ch
  WHERE ch.session_id = s.id ORDER BY ch.seq DESC LIMIT 1
) lc ON TRUE
WHERE c.session_id = s.id AND c.last_hash IS NOT DISTINCT FROM s.transcript_hash;

UPDATE sessions.sessions s
SET outline_hash = CASE
      WHEN s.outline_hash IS NOT DISTINCT FROM s.transcript_hash
        THEN md5(s.ingested_bytes::text || ':' || lc.content_hash)
      ELSE s.outline_hash
    END,
    transcript_hash = md5(s.ingested_bytes::text || ':' || lc.content_hash)
FROM (
  SELECT DISTINCT ON (session_id) session_id, content_hash
  FROM sessions.transcript_chunks
  ORDER BY session_id, seq DESC
) lc
WHERE lc.session_id = s.id;
