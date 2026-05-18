alter table items
add column if not exists source_key text;

create unique index if not exists items_source_key_uidx
on items(source_key)
where source_key is not null;

create unique index if not exists documents_item_file_uidx
on documents(item_id, file_name)
where file_name is not null;

create unique index if not exists section_rows_item_section_title_uidx
on section_rows(item_id, section, title)
where title is not null;
