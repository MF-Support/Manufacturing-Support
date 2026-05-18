insert into storage.buckets (id, name, public)
values ('manufacturing-documents', 'manufacturing-documents', false)
on conflict (id) do update set public = false;

drop policy if exists "authenticated users can read manufacturing documents" on storage.objects;
create policy "authenticated users can read manufacturing documents"
on storage.objects for select
to authenticated
using (bucket_id = 'manufacturing-documents');
