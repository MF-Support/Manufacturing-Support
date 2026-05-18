# Supabase Migration

## Target Tables

Use normalized tables so search results can move from platform to part to related records.

```sql
create table platforms (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table items (
  id bigint generated always as identity primary key,
  platform_id bigint references platforms(id) on delete set null,
  item_id text,
  part_number text,
  description text,
  type text,
  category text,
  status text,
  revision text,
  related_family_key text,
  raw jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(part_number,'') || ' ' || coalesce(description,'') || ' ' || coalesce(type,'') || ' ' || coalesce(category,''))
  ) stored,
  created_at timestamptz not null default now()
);

create index items_search_idx on items using gin(search_vector);
create index items_part_number_idx on items(part_number);
create index items_family_idx on items(related_family_key);

create table documents (
  id bigint generated always as identity primary key,
  item_id bigint not null references items(id) on delete cascade,
  file_name text,
  title text,
  document_type text,
  vault text,
  storage_path text,
  metadata jsonb not null default '{}'::jsonb
);

create table section_rows (
  id bigint generated always as identity primary key,
  item_id bigint not null references items(id) on delete cascade,
  section text not null check (section in ('vendors','parts_list_bom','where_used','changes_ecos')),
  title text,
  body text,
  row_data jsonb not null default '{}'::jsonb
);
```

## Storage

Create a private bucket:

```text
manufacturing-documents
```

Store files with stable paths such as:

```text
platform/part-number/file-name.pdf
```

## Import Flow

Run the key migration after the base schema:

```sql
-- Supabase SQL Editor
-- Run supabase/002_import_keys.sql
```

Create a private storage bucket named:

```text
manufacturing-documents
```

Then import from the local machine that has the cleaned files:

```powershell
$env:SUPABASE_URL="https://YOUR-PROJECT.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="YOUR-SERVICE-ROLE-KEY"
$env:SUPABASE_STORAGE_BUCKET="manufacturing-documents"
$env:MSD_SOURCE_DIR="C:\path\to\Omnify_All_Parts_Cleaned"
python scripts\import_to_supabase.py
```

Recommended first test:

```powershell
python scripts\import_to_supabase.py --dry-run --limit 25
```

The importer:

1. Reads each cleaned `breakdown.json`.
2. Upserts platforms by name.
3. Upserts items by stable `source_key`.
4. Uploads document files to Supabase Storage.
5. Upserts document metadata.
6. Upserts vendors, BOM, Where Used, and ECO rows into `section_rows`.
7. Stores `related_family_key` so combined records can be queried later.

## Security

Before exposing the frontend:

- Enable Row Level Security on all tables.
- Use Supabase Auth.
- Add read policies for approved users or groups.
- Keep the service-role key only in local import scripts or server-side jobs.
- Never place service-role credentials in browser code.
