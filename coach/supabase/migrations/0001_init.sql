-- 매장 판매 코칭 앱: 스키마, RLS, RPC, 스토리지
-- 역할: admin(본사) · manager(매장 매니저) · employee(사원)

create schema if not exists private;
grant usage on schema private to authenticated;

-- ---------- 테이블 ----------
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','manager','employee')),
  name text not null,
  emp_no text unique,
  email text,
  store_id uuid references public.stores(id),
  manager_id uuid references public.profiles(id),
  must_change_pw boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.profiles (store_id);

create table public.criteria (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  weight numeric not null default 1 check (weight > 0),
  sort_order int not null default 0,
  active boolean not null default true
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  starts_on date,
  ends_on date,
  active boolean not null default true,
  -- [{id, type: '필수 설명'|'필수 콜멘트'|'금지 표현', text}]
  checklist jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  title text not null,
  file_path text,
  mime text,
  text_content text,
  created_at timestamptz not null default now()
);
create index on public.materials (product_id);

create table public.evaluations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  uploaded_by uuid not null default auth.uid() references public.profiles(id),
  store_id uuid references public.stores(id),
  product_id uuid not null references public.products(id),
  kind text not null check (kind in ('practice','proxy')),
  attempt_no int,
  status text not null default 'uploading'
    check (status in ('uploading','transcribing','analyzing','practice','submitted','reviewing','completed','failed')),
  error text,
  audio_path text,
  audio_deleted boolean not null default false,
  audio_seconds int,
  orig_name text,
  orig_size bigint,
  sent_size bigint,
  transcript jsonb,
  ai jsonb,
  ai_total numeric,
  compliance_rate int,
  self_note text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.evaluations (employee_id, product_id);
create index on public.evaluations (store_id, status);
-- 사원 · 행사 품목당 매니저에게 낸 연습은 1건
create unique index evaluations_one_submission
  on public.evaluations (employee_id, product_id)
  where kind = 'practice' and status in ('submitted','reviewing','completed');

create table public.manager_reviews (
  evaluation_id uuid primary key references public.evaluations(id) on delete cascade,
  manager_id uuid not null references public.profiles(id),
  scores jsonb not null default '[]'::jsonb,   -- [{criterion_id, name, score}]
  total numeric,
  comment text not null default '',
  tasks text[] not null default '{}',
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.best_practices (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null unique references public.evaluations(id) on delete cascade,
  shared_by uuid not null references public.profiles(id),
  store_id uuid references public.stores(id),
  emp_name text not null,
  store_name text not null,
  product_id uuid references public.products(id),
  product_name text not null,
  manager_name text not null,
  score numeric,
  compliance_rate int,
  audio_path text not null,
  audio_seconds int,
  point text not null,
  chapters jsonb not null default '[]'::jsonb,  -- [{time, label, quote}]
  scope text not null default 'all' check (scope in ('all','store')),
  consent_employee boolean not null check (consent_employee),
  consent_privacy boolean not null check (consent_privacy),
  hidden boolean not null default false,
  plays int not null default 0,
  created_at timestamptz not null default now()
);

create table public.best_likes (
  best_id uuid references public.best_practices(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade default auth.uid(),
  primary key (best_id, user_id)
);

create table private.settings (key text primary key, value text not null);

-- ---------- 보조 함수 ----------
create or replace function private.my_role() returns text
language sql stable security definer set search_path = '' as
$$ select role from public.profiles where id = auth.uid() and active $$;

create or replace function private.my_store() returns uuid
language sql stable security definer set search_path = '' as
$$ select store_id from public.profiles where id = auth.uid() and active $$;

create or replace function private.store_of(p uuid) returns uuid
language sql stable security definer set search_path = '' as
$$ select store_id from public.profiles where id = p $$;

-- 매니저/관리자가 이 평가를 볼 수 있는지 (사원 본인 여부는 따로 확인)
create or replace function private.staff_can_see(e public.evaluations) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.my_role() = 'admin'
      or (private.my_role() = 'manager' and e.store_id = private.my_store()
          and (e.kind = 'proxy' or e.status in ('submitted','reviewing','completed')))
$$;

grant execute on all functions in schema private to authenticated;

-- ---------- 트리거 ----------
create or replace function private.evaluations_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.store_id := private.store_of(new.employee_id);
  if new.kind = 'practice' then
    select coalesce(max(attempt_no), 0) + 1 into new.attempt_no
      from public.evaluations
     where employee_id = new.employee_id and product_id = new.product_id and kind = 'practice';
  end if;
  return new;
end $$;
create trigger evaluations_bi before insert on public.evaluations
  for each row execute function private.evaluations_before_insert();

create or replace function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger evaluations_bu before update on public.evaluations
  for each row execute function private.touch_updated_at();

-- ---------- RLS ----------
alter table public.stores enable row level security;
alter table public.profiles enable row level security;
alter table public.criteria enable row level security;
alter table public.products enable row level security;
alter table public.materials enable row level security;
alter table public.evaluations enable row level security;
alter table public.manager_reviews enable row level security;
alter table public.best_practices enable row level security;
alter table public.best_likes enable row level security;
alter table private.settings enable row level security;

create policy stores_read on public.stores for select to authenticated using (true);
create policy stores_admin on public.stores for all to authenticated
  using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');

create policy profiles_read on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or (select private.my_role()) = 'admin'
  or ((select private.my_role()) = 'manager' and store_id = (select private.my_store()))
);
create policy profiles_admin on public.profiles for update to authenticated
  using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');

create policy criteria_read on public.criteria for select to authenticated using (true);
create policy criteria_admin on public.criteria for all to authenticated
  using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');

create policy products_read on public.products for select to authenticated using (true);
create policy products_admin on public.products for all to authenticated
  using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');

create policy materials_read on public.materials for select to authenticated using (true);
create policy materials_admin on public.materials for all to authenticated
  using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');

create policy evaluations_read on public.evaluations for select to authenticated
  using (employee_id = (select auth.uid()) or private.staff_can_see(evaluations));
create policy evaluations_insert on public.evaluations for insert to authenticated with check (
  status = 'uploading' and uploaded_by = (select auth.uid()) and (
    (kind = 'practice' and employee_id = (select auth.uid()) and (select private.my_role()) = 'employee')
    or (kind = 'proxy' and (select private.my_role()) in ('manager','admin')
        and ((select private.my_role()) = 'admin' or private.store_of(employee_id) = (select private.my_store())))
  )
);
create policy evaluations_delete on public.evaluations for delete to authenticated using (
  employee_id = (select auth.uid()) and kind = 'practice' and status in ('practice','failed','uploading')
);

create policy reviews_read on public.manager_reviews for select to authenticated using (
  exists (select 1 from public.evaluations e where e.id = evaluation_id
          and (private.staff_can_see(e) or (e.employee_id = (select auth.uid()) and e.status = 'completed')))
);

create policy best_read on public.best_practices for select to authenticated using (
  (select private.my_role()) = 'admin'
  or (not hidden and (scope = 'all' or store_id = (select private.my_store())))
);
create policy best_admin on public.best_practices for update to authenticated
  using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');
create policy best_admin_delete on public.best_practices for delete to authenticated
  using ((select private.my_role()) = 'admin');

create policy likes_read on public.best_likes for select to authenticated using (true);
create policy likes_own on public.best_likes for insert to authenticated with check (user_id = (select auth.uid()));
create policy likes_own_delete on public.best_likes for delete to authenticated using (user_id = (select auth.uid()));

-- ---------- RPC ----------
-- 사원: 연습 1건을 매니저에게 제출(또는 바꾸기)
create or replace function public.submit_attempt(p_eval uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.evaluations;
begin
  select * into e from public.evaluations where id = p_eval for update;
  if e.id is null or e.employee_id <> auth.uid() or e.kind <> 'practice' then
    raise exception '제출할 수 없는 기록이에요';
  end if;
  if e.status not in ('practice','submitted') then
    raise exception '분석이 끝난 연습만 제출할 수 있어요';
  end if;
  if exists (select 1 from public.evaluations x where x.employee_id = e.employee_id and x.product_id = e.product_id
             and x.kind = 'practice' and x.status in ('reviewing','completed')) then
    raise exception '이 행사는 매니저 평가가 이미 시작돼서 바꿀 수 없어요';
  end if;
  update public.evaluations set status = 'practice', self_note = null, submitted_at = null
   where employee_id = e.employee_id and product_id = e.product_id and kind = 'practice'
     and status = 'submitted' and id <> e.id;
  update public.evaluations set status = 'submitted', self_note = nullif(trim(p_note), ''), submitted_at = now()
   where id = e.id;
end $$;

-- 사원: 제출 취소
create or replace function public.withdraw_attempt(p_eval uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.evaluations set status = 'practice', submitted_at = null
   where id = p_eval and employee_id = auth.uid() and status = 'submitted';
  if not found then raise exception '취소할 수 없는 상태예요'; end if;
end $$;

-- 매니저: 평가 저장(임시 저장 또는 완료)
create or replace function public.save_review(p_eval uuid, p_scores jsonb, p_comment text, p_tasks text[], p_complete boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.evaluations; v_total numeric;
begin
  select * into e from public.evaluations where id = p_eval for update;
  if e.id is null or not private.staff_can_see(e) then raise exception '평가할 수 없는 기록이에요'; end if;
  if e.status not in ('submitted','reviewing') then raise exception '평가 대기 중인 기록이 아니에요'; end if;
  select round(sum((s->>'score')::numeric * coalesce(c.weight, 1)) / nullif(sum(coalesce(c.weight, 1)), 0), 1)
    into v_total
    from jsonb_array_elements(p_scores) s
    left join public.criteria c on c.id = (s->>'criterion_id')::uuid;
  insert into public.manager_reviews (evaluation_id, manager_id, scores, total, comment, tasks, completed_at, updated_at)
  values (e.id, auth.uid(), p_scores, v_total, coalesce(p_comment, ''), coalesce(p_tasks, '{}'),
          case when p_complete then now() end, now())
  on conflict (evaluation_id) do update set manager_id = excluded.manager_id, scores = excluded.scores,
    total = excluded.total, comment = excluded.comment, tasks = excluded.tasks,
    completed_at = excluded.completed_at, updated_at = now();
  update public.evaluations set status = case when p_complete then 'completed' else 'reviewing' end where id = e.id;
end $$;

-- 매니저: 우수 사례 공유
create or replace function public.share_best(p_eval uuid, p_point text, p_chapters jsonb, p_scope text,
                                             p_consent_employee boolean, p_consent_privacy boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare e public.evaluations; r public.manager_reviews; v_id uuid;
begin
  select * into e from public.evaluations where id = p_eval;
  if e.id is null or not private.staff_can_see(e) or private.my_role() <> 'manager' and private.my_role() <> 'admin' then
    raise exception '공유할 수 없는 기록이에요';
  end if;
  if e.status <> 'completed' then raise exception '평가를 완료한 대화만 공유할 수 있어요'; end if;
  if e.audio_path is null or e.audio_deleted then raise exception '녹음 파일이 남아 있지 않아요'; end if;
  if not (p_consent_employee and p_consent_privacy) then raise exception '사원 동의와 개인정보 확인이 필요해요'; end if;
  select * into r from public.manager_reviews where evaluation_id = e.id;
  insert into public.best_practices (evaluation_id, shared_by, store_id, emp_name, store_name, product_id, product_name,
    manager_name, score, compliance_rate, audio_path, audio_seconds, point, chapters, scope, consent_employee, consent_privacy)
  select e.id, auth.uid(), e.store_id, pe.name, coalesce(s.name, ''), e.product_id, p.name,
         (select name from public.profiles where id = auth.uid()), coalesce(r.total, e.ai_total), e.compliance_rate,
         e.audio_path, e.audio_seconds, trim(p_point), coalesce(p_chapters, '[]'::jsonb),
         case when p_scope = 'store' then 'store' else 'all' end, p_consent_employee, p_consent_privacy
    from public.profiles pe
    left join public.stores s on s.id = e.store_id
    join public.products p on p.id = e.product_id
   where pe.id = e.employee_id
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.play_best(p_id uuid)
returns void language sql security definer set search_path = '' as
$$ update public.best_practices set plays = plays + 1 where id = p_id $$;

-- 첫 로그인 비밀번호 변경 완료 표시
create or replace function public.password_changed()
returns void language sql security definer set search_path = '' as
$$ update public.profiles set must_change_pw = false where id = auth.uid() $$;

-- 매니저/관리자: 팀 연습 현황(연습 내용은 보이지 않고 횟수와 AI 점수 추이만)
create or replace function public.team_practice_stats()
returns table (employee_id uuid, name text, emp_no text, attempts int, recent numeric[], last_at timestamptz, submitted int, completed int)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, p.emp_no,
         count(e.id) filter (where e.kind = 'practice' and e.ai_total is not null)::int,
         (array_agg(e.ai_total order by e.created_at desc) filter (where e.ai_total is not null))[1:8],
         max(e.created_at),
         count(e.id) filter (where e.status in ('submitted','reviewing'))::int,
         count(e.id) filter (where e.status = 'completed')::int
    from public.profiles p
    left join public.evaluations e on e.employee_id = p.id and e.created_at > now() - interval '60 days'
   where p.role = 'employee' and p.active
     and (private.my_role() = 'admin' or (private.my_role() = 'manager' and p.store_id = private.my_store()))
   group by p.id
   order by p.name
$$;

-- 항목별 평균(AI 점수) - 매장 또는 전체, 최근 60일
create or replace function public.criteria_averages(p_store uuid default null)
returns table (criterion_id uuid, avg numeric)
language sql stable security definer set search_path = '' as $$
  select (i->>'criterion_id')::uuid, round(avg((i->>'score')::numeric), 1)
    from public.evaluations e, jsonb_array_elements(e.ai->'items') i
   where e.ai is not null and e.created_at > now() - interval '60 days'
     and (p_store is null or e.store_id = p_store)
     and auth.uid() is not null
   group by 1
$$;

-- 행사별로 자주 놓치는 교육 내용 - 매장 또는 전체, 최근 60일
create or replace function public.missed_items(p_store uuid default null)
returns table (product_id uuid, product_name text, item text, missed_pct int, n int)
language sql stable security definer set search_path = '' as $$
  select e.product_id, p.name, c->>'text',
         round(100.0 * count(*) filter (where c->>'status' in ('missed','violation')) / count(*))::int, count(*)::int
    from public.evaluations e
    join public.products p on p.id = e.product_id,
         jsonb_array_elements(e.ai->'compliance') c
   where e.ai is not null and e.created_at > now() - interval '60 days'
     and (p_store is null or e.store_id = p_store)
     and private.my_role() in ('manager','admin')
     and (private.my_role() = 'admin' or e.store_id = private.my_store())
   group by 1, 2, 3
  having count(*) >= 3
   order by 4 desc
   limit 12
$$;

-- 관리자: 매장별 현황
create or replace function public.store_overview()
returns table (store_id uuid, store_name text, managers text, employees int, attempts int, avg_score numeric, avg_compliance int, waiting int)
language sql stable security definer set search_path = '' as $$
  select s.id, s.name,
         (select string_agg(m.name, ', ') from public.profiles m where m.store_id = s.id and m.role = 'manager' and m.active),
         (select count(*) from public.profiles m where m.store_id = s.id and m.role = 'employee' and m.active)::int,
         (select count(*) from public.evaluations e where e.store_id = s.id and e.kind = 'practice'
            and e.created_at > now() - interval '30 days')::int,
         (select round(avg(r.total), 1) from public.manager_reviews r join public.evaluations e on e.id = r.evaluation_id
           where e.store_id = s.id and r.completed_at > now() - interval '60 days'),
         (select round(avg(e.compliance_rate))::int from public.evaluations e
           where e.store_id = s.id and e.compliance_rate is not null and e.created_at > now() - interval '60 days'),
         (select count(*) from public.evaluations e where e.store_id = s.id and e.status in ('submitted','reviewing'))::int
    from public.stores s
   where private.my_role() = 'admin'
   order by s.name
$$;

revoke execute on all functions in schema public from anon;

-- ---------- 기본 평가 항목 ----------
insert into public.criteria (name, description, sort_order) values
 ('제품특징', '제품의 핵심 특징과 근거(성분·수치)를 정확히 설명했는가', 1),
 ('제품사용설명', '사용 순서, 사용량, 사용 시점을 구체적으로 안내했는가', 2),
 ('묶음판매', '행사 조건과 함께 쓰면 좋은 제품을 자연스럽게 연결했는가', 3),
 ('친절', '인사, 존댓말, 기다려 주기 등 응대 태도가 좋았는가', 4),
 ('자신감', '질문에 머뭇거리지 않고 확신 있게 답했는가', 5),
 ('고객소통', '고객 말을 끊지 않고 듣고, 되물어 확인했는가', 6),
 ('고객 니즈 파악', '피부 타입, 현재 사용 제품, 고민을 질문으로 파악했는가', 7),
 ('개인화된 제품 추천', '파악한 니즈를 추천 이유에 연결했는가', 8),
 ('재치 있는 멘트', '분위기를 풀고 기억에 남는 표현을 썼는가', 9),
 ('클로징 능력', '망설이는 고객에게 혜택·마감을 활용해 구매를 제안했는가', 10);

-- ---------- 스토리지 ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 52428800,
        array['audio/mp4','audio/m4a','audio/x-m4a','audio/aac','audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/webm','audio/ogg','audio/flac'])
on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit)
values ('materials', 'materials', false, 52428800)
on conflict (id) do nothing;

-- 녹음 읽기: 평가를 볼 수 있거나, 볼 수 있는 우수 사례의 녹음
create or replace function private.can_read_recording(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.evaluations e
     where e.audio_path = p_name and (e.employee_id = auth.uid() or private.staff_can_see(e))
  ) or exists (
    select 1 from public.best_practices b
     where b.audio_path = p_name
       and (private.my_role() = 'admin' or (not b.hidden and (b.scope = 'all' or b.store_id = private.my_store())))
  )
$$;
-- 녹음 올리기: 본인이 방금 만든(업로드 중) 평가의 경로에만
create or replace function private.can_upload_recording(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.evaluations e
     where e.id::text = split_part(p_name, '.', 1) and e.uploaded_by = auth.uid() and e.status = 'uploading'
  )
$$;
grant execute on function private.can_read_recording(text), private.can_upload_recording(text) to authenticated;

create policy recordings_read on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and private.can_read_recording(name));
create policy recordings_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and private.can_upload_recording(name));

create policy materials_read on storage.objects for select to authenticated
  using (bucket_id = 'materials');
create policy materials_write on storage.objects for insert to authenticated
  with check (bucket_id = 'materials' and private.my_role() = 'admin');
create policy materials_delete on storage.objects for delete to authenticated
  using (bucket_id = 'materials' and private.my_role() = 'admin');
