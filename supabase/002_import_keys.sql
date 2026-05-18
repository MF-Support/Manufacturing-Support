alter table items
add column if not exists source_key text;

drop index if exists items_source_key_uidx;
create unique index if not exists items_source_key_uidx
on items(source_key);

drop index if exists documents_item_file_uidx;
alter table documents
add column if not exists document_key text;

drop index if exists documents_document_key_uidx;
create unique index if not exists documents_document_key_uidx
on documents(document_key);

drop index if exists section_rows_item_section_title_uidx;
alter table section_rows
add column if not exists row_key text;

drop index if exists section_rows_row_key_uidx;
create unique index if not exists section_rows_row_key_uidx
on section_rows(row_key);
