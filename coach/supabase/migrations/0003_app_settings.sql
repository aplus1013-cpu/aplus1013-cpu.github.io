-- 서버 함수(service role)만 읽는 설정값. 정책이 없으므로 앱 사용자는 읽을 수 없음.
drop table if exists private.settings;
create table public.app_settings (key text primary key, value text not null);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

-- 첫 관리자 설정 코드 (1회용, 관리자가 생기면 무효)
insert into public.app_settings (key, value)
values ('setup_code', upper(substr(md5(gen_random_uuid()::text), 1, 8)));
