create table if not exists platforms (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists items (
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
    to_tsvector(
      'english',
      coalesce(part_number, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(type, '') || ' ' ||
      coalesce(category, '')
    )
  ) stored,
  created_at timestamptz not null default now()
);

create index if not exists items_search_idx on items using gin(search_vector);
create index if not exists items_part_number_idx on items(part_number);
create index if not exists items_family_idx on items(related_family_key);

create table if not exists documents (
  id bigint generated always as identity primary key,
  item_id bigint not null references items(id) on delete cascade,
  file_name text,
  title text,
  document_type text,
  vault text,
  storage_path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists section_rows (
  id bigint generated always as identity primary key,
  item_id bigint not null references items(id) on delete cascade,
  section text not null check (section in ('vendors','parts_list_bom','where_used','changes_ecos')),
  title text,
  body text,
  row_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table platforms enable row level security;
alter table items enable row level security;
alter table documents enable row level security;
alter table section_rows enable row level security;

-- Example read policy. Replace with company-approved access rules before production.
create policy "authenticated users can read platforms"
on platforms for select
to authenticated
using (true);

create policy "authenticated users can read items"
on items for select
to authenticated
using (true);

create policy "authenticated users can read documents"
on documents for select
to authenticated
using (true);

create policy "authenticated users can read section rows"
on section_rows for select
to authenticated
using (true);
