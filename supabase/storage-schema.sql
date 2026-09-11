-- Public bucket for auto-converted video files (Vimeo/Dailymotion auto-convert,
-- /api/downloads/prepare, /api/downloads/mp4). Run once in the Supabase SQL
-- Editor before setting SUPABASE_STORAGE_ENABLED=true.
--
-- No user auth of any kind: the API server uploads with the anon key alone,
-- matching the fact that /downloads/<file> on the VPS is itself already
-- unauthenticated — there is no login in this app to require anything
-- stronger. This is a different, much lower bar than download_history in
-- schema.sql, which holds real per-user data and is protected by RLS tied to
-- a real (or anonymous) Supabase session.
--
-- IMPORTANT: this bucket allows the ANON key to upload and delete. Do not
-- ship this same anon key inside the mobile app for anything else while this
-- policy exists — a public-write bucket plus a key anyone can extract from
-- the APK is an open door to arbitrary storage abuse. Today the anon key
-- lives only on the VPS, which is what makes this safe.

insert into storage.buckets (id, name, public)
values ('downloads', 'downloads', true)
on conflict (id) do nothing;

drop policy if exists "anon can upload to downloads bucket" on storage.objects;
create policy "anon can upload to downloads bucket"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'downloads');

drop policy if exists "anon can overwrite in downloads bucket" on storage.objects;
create policy "anon can overwrite in downloads bucket"
  on storage.objects for update
  to anon
  using (bucket_id = 'downloads')
  with check (bucket_id = 'downloads');

drop policy if exists "anon can delete from downloads bucket" on storage.objects;
create policy "anon can delete from downloads bucket"
  on storage.objects for delete
  to anon
  using (bucket_id = 'downloads');

-- No read policy needed: the bucket is public, so GET is already open to
-- anyone with the object's URL — the same access level /downloads/<file>
-- already has on the VPS.
