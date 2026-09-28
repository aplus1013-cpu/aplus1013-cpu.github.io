-- 로컬 테스트용: Supabase가 기본 제공하는 스키마·역할을 흉내 냄 (실제 서버에는 적용하지 않음)
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password text not null,
  raw_user_meta_data jsonb default '{}'::jsonb,
  banned boolean not null default false,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  bucket_id text references storage.buckets(id), name text, owner uuid default auth.uid(),
  size bigint, mime text, data bytea, created_at timestamptz default now(),
  primary key (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.objects, storage.buckets to authenticated, service_role;
create schema extensions;
