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

1. Read each cleaned `breakdown.json`.
2. Upsert platform.
3. Insert item record.
4. Upload document files to Supabase Storage.
5. Insert document metadata.
6. Insert vendors, BOM, Where Used, and ECO rows into `section_rows`.
7. Recompute or store related family keys for combined items.

## Security

Before exposing the frontend:

- Enable Row Level Security on all tables.
- Use Supabase Auth.
- Add read policies for approved users or groups.
- Keep the service-role key only in local import scripts or server-side jobs.
- Never place service-role credentials in browser code.
