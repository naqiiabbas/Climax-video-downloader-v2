-- Download history for the mobile app.
--
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- The API server never uses the service_role key. It forwards each user's own
-- access token to PostgREST, so the policies below are what actually enforce
-- isolation: a user can only ever see and delete their own rows.

create table if not exists public.download_history (
  id              uuid primary key default gen_random_uuid(),

  -- Filled automatically from the caller's JWT. The client cannot set it to
  -- someone else's id, because the INSERT policy below re-checks it.
  user_id         uuid not null default auth.uid()
                    references auth.users (id) on delete cascade,

  source          text,          -- 'Youtube', 'TikTok', 'Facebook', ...
  page_url        text not null, -- the link the user pasted
  title           text,
  author          text,
  thumbnail       text,
  duration        numeric,       -- seconds
  quality         text,          -- '1080', '720', 'best', ...
  file_size_bytes bigint,

  created_at      timestamptz not null default now()
);

-- The only query the app makes: this user's rows, newest first.
create index if not exists download_history_user_created_idx
  on public.download_history (user_id, created_at desc);

alter table public.download_history enable row level security;

-- Recreate policies idempotently so this file can be re-run safely.
drop policy if exists "read own history"   on public.download_history;
drop policy if exists "insert own history" on public.download_history;
drop policy if exists "delete own history" on public.download_history;

create policy "read own history"
  on public.download_history
  for select
  using (auth.uid() = user_id);

-- with check re-validates user_id, so a client cannot insert a row attributed
-- to another account even though the column has a default.
create policy "insert own history"
  on public.download_history
  for insert
  with check (auth.uid() = user_id);

create policy "delete own history"
  on public.download_history
  for delete
  using (auth.uid() = user_id);

-- No update policy on purpose: history entries are a log. The app creates and
-- deletes them; nothing edits one in place.
