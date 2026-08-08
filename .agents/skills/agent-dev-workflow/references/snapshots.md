# Production snapshots (optional — only if the project has a prod DB)

Some projects want to load production-like data locally. This is **purely
opt-in** and only makes sense once there's a production database to snapshot. A
greenfield project (no prod yet) should skip all of this — adding it early is
dead weight.

When a project *does* have real prod data, this is usually its **seeding
strategy**: `bin/load-snapshot` (default → latest) replaces hand-written fixtures
entirely (the "snapshot-as-seed" posture in **`migrations-and-seeds.md`**). One
caveat for clean restores: pin the **same Postgres major as production** locally, so
a `strip_cloudsql`'d dump doesn't hit version-mismatch surprises.

Two scripts, both built on helpers already in `_common.sh`.

## bin/snapshot — export prod → object storage

For a GCP Cloud SQL prod instance, export server-side (no public IP / maintenance
mode needed) to a bucket:

```bash
gcloud sql export sql "$INSTANCE" "gs://${BUCKET}/${filename}" \
  --database="$DATABASE" --project="$PROJECT" --clean --if-exists --quiet
```

Cloud SQL refuses to overwrite an existing object, so `rm` it first. The Cloud
SQL service account needs write access to the bucket (`roles/storage.objectAdmin`
on the bucket, or reuse an existing tfstate/snapshots bucket). A bucket lifecycle
rule (e.g. delete after 30 days) keeps snapshots from accumulating.

## bin/load-snapshot — load a snapshot into this context's DB

Accept a local path **or** a `gs://` URL (stream straight from the bucket — no
local download). Drop → recreate → load → migrate:

```bash
snapshot="${1:-gs://${BUCKET}/latest.sql}"
app_recreate_db "$(app_db_name)"
if [[ "$snapshot" == gs://* ]]; then
  gcloud storage cat "$snapshot" | strip_cloudsql | app_psql -d "$(app_db_name)"
else
  strip_cloudsql < "$snapshot" | app_psql -d "$(app_db_name)"
fi
app_migrate "$(app_database_url)"   # applies any migrations newer than the snapshot
```

`bin/setup <snapshot>` does the same in one step (see the setup template).

## strip_cloudsql — why it exists

Cloud SQL's `pg_dump` wrapper injects directives a vanilla local Postgres chokes
on: `\restrict`/`\unrestrict` psql meta-commands and `GRANT … TO cloudsqlsuperuser`
(a role that doesn't exist locally). Add this filter to `_common.sh` and pipe
dumps through it on load:

```bash
strip_cloudsql() {
  grep -v -E '^\\(restrict|unrestrict) |cloudsqlsuperuser'
}
```

Non-GCP equivalents: AWS RDS → `aws rds ...` or `pg_dump` over the wire to S3;
self-hosted → plain `pg_dump`. The shape is identical (export → object store →
stream into `app_recreate_db` + load + migrate); only the export command and the
provider-specific `strip_*` filter change.
