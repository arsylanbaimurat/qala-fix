-- Qala.fix pilot: схема базы для Supabase.
-- Как применить: Supabase → SQL Editor → New query → вставить весь файл → Run.
-- Файл можно запускать повторно: он ничего не удаляет.
-- В конце запрос покажет два инвайт-кода: для жителей и для модератора.

-- ============ Таблицы ============

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null default 'resident' check (role in ('resident','moderator')),
  banned      boolean not null default false,
  consent_at  timestamptz not null default now(),
  invite_code text,
  created_at  timestamptz not null default now()
);

alter table public.profiles add column if not exists recovery_hash text;

create table if not exists public.invite_codes (
  code      text primary key,
  role      text not null default 'resident' check (role in ('resident','moderator')),
  max_uses  int  not null default 200,
  uses      int  not null default 0,
  active    boolean not null default true
);

create table if not exists public.complaints (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  author          uuid not null references public.profiles(id) on delete cascade,
  city            text not null default 'astana',
  cat             text not null,
  custom_type     text check (char_length(custom_type) <= 60),
  custom_sev      int  check (custom_sev between 1 and 3),
  moderated       boolean not null default false,   -- «Другое» проверено модератором
  description     text check (char_length(description) <= 1000),
  address         text check (char_length(address) <= 200),
  lat             double precision not null,
  lng             double precision not null,
  photo_path      text,
  status          text not null default 'collecting'
                  check (status in ('collecting','to_send','sent','in_work','verifying','fixed')),
  ticket_channel  text check (ticket_channel in ('eotinish','ikomek','other')),
  ticket_no       text check (char_length(ticket_no) <= 60),
  sent_at         timestamptz,
  answered_at     timestamptz,
  verifying_since timestamptz,
  fixed_at        timestamptz,
  akimat_reported boolean not null default false,
  contractor      text,
  warranty_until  date,
  reopen_count    int not null default 0,
  round           int not null default 0,          -- раунд проверки ремонта, растёт при откате
  conf_count      int not null default 0,
  fixed_count     int not null default 0,
  notfixed_count  int not null default 0,
  bad_count       int not null default 0,
  bad_photo_path  text,                             -- последнее фото «сделано плохо / снова сломалось»
  hidden          boolean not null default false,
  hidden_reason   text,
  updated_at      timestamptz not null default now()
);
alter table public.complaints add column if not exists bad_photo_path text;
-- Ответ акимата: скриншот ответа, обещанный срок, короткая выдержка
alter table public.complaints add column if not exists answer_photo_path text;
alter table public.complaints add column if not exists answer_deadline date;
alter table public.complaints add column if not exists answer_note text check (char_length(answer_note) <= 300);

create index if not exists complaints_city_idx on public.complaints (city, status);
create index if not exists complaints_geo_idx  on public.complaints (lat, lng);

-- Голоса. Координаты голосующего НЕ храним: только расстояние до точки.
create table if not exists public.votes (
  complaint_id bigint not null references public.complaints(id) on delete cascade,
  user_id      uuid   not null references public.profiles(id) on delete cascade,
  kind         text   not null check (kind in ('confirm','fixed','notfixed','bad')),
  round        int    not null default 0,
  dist_m       int,
  photo_path   text,                                -- обязательное свежее фото для «сделано плохо»
  created_at   timestamptz not null default now(),
  primary key (complaint_id, user_id, kind, round)
);
alter table public.votes add column if not exists photo_path text;

-- История жалобы: ответы акимата, скрины, фото и комментарии автора / модератора. Видна всем.
create table if not exists public.complaint_updates (
  id           bigint generated always as identity primary key,
  complaint_id bigint not null references public.complaints(id) on delete cascade,
  author       uuid   not null references public.profiles(id) on delete cascade,
  kind         text   not null check (kind in ('note','answer','reported','ticket')),
  note         text   check (char_length(note) <= 500),
  photo_path   text,
  created_at   timestamptz not null default now()
);
-- Журнал удалений: кто, когда, почему и что было удалено (копия жалобы). Видит только модератор.
create table if not exists public.deletion_log (
  id           bigint generated always as identity primary key,
  complaint_id bigint not null,
  actor        uuid,
  reason       text,
  snapshot     jsonb not null,
  created_at   timestamptz not null default now()
);

create index if not exists complaint_updates_c_idx on public.complaint_updates (complaint_id, created_at);

-- ============ Справочник категорий (как в прототипе) ============

create or replace function public.cat_sev(p_cat text) returns int
language sql immutable as $$
  select case p_cat
    when 'manhole' then 3 when 'wires' then 3 when 'sinkhole' then 3
    when 'pothole' then 2 when 'paving' then 2 when 'light' then 2 when 'traffic' then 2
    when 'drain' then 1 when 'trash' then 1 when 'bench' then 1
    when 'other' then 1
    else null end
$$;

create or replace function public.effective_sev(c public.complaints) returns int
language sql stable as $$
  select case when c.cat = 'other'
    then case when c.moderated then coalesce(c.custom_sev,1) else least(coalesce(c.custom_sev,1), 2) end
    else public.cat_sev(c.cat) end
$$;

-- ============ Помощники ============

create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'moderator' and not banned)
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and not banned)
$$;

create or replace function public.dist_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8
language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- ============ Вход в пилот по инвайт-коду ============

create or replace function public.join_pilot(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare v_code invite_codes; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if exists (select 1 from profiles where id = v_uid) then
    return (select role from profiles where id = v_uid);
  end if;
  select * into v_code from invite_codes
   where upper(code) = upper(trim(p_code)) and active and uses < max_uses for update;
  if not found then raise exception 'bad_code'; end if;
  update invite_codes set uses = uses + 1 where code = v_code.code;
  insert into profiles (id, role, invite_code) values (v_uid, v_code.role, v_code.code);
  return v_code.role;
end $$;

-- ============ Создание жалобы ============

create or replace function public.create_complaint(
  p_city text, p_cat text, p_custom_type text, p_custom_sev int,
  p_description text, p_address text, p_lat float8, p_lng float8, p_photo_path text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_uid uuid := auth.uid(); v_status text := 'collecting';
begin
  if not is_member() then raise exception 'not_member'; end if;
  if cat_sev(p_cat) is null then raise exception 'bad_cat'; end if;
  if p_cat = 'other' and coalesce(trim(p_custom_type),'') = '' then raise exception 'custom_type_required'; end if;
  if p_lat not between 40 and 56 or p_lng not between 46 and 88 then raise exception 'outside_kz'; end if;
  if (select count(*) from complaints where author = v_uid and created_at > now() - interval '1 day') >= 15 then
    raise exception 'rate_limit';
  end if;
  if p_photo_path is not null and p_photo_path not like v_uid::text || '/%' then raise exception 'bad_photo'; end if;
  -- Опасная категория (не «Другое») сразу идёт в очередь на отправку
  if p_cat <> 'other' and cat_sev(p_cat) = 3 then v_status := 'to_send'; end if;

  insert into complaints (author, city, cat, custom_type, custom_sev, description, address, lat, lng, photo_path, status, conf_count)
  values (v_uid, coalesce(p_city,'astana'), p_cat,
          case when p_cat = 'other' then left(trim(p_custom_type),60) end,
          case when p_cat = 'other' then coalesce(p_custom_sev,1) end,
          left(p_description,1000), left(p_address,200), p_lat, p_lng, p_photo_path, v_status, 1)
  returning id into v_id;
  insert into votes (complaint_id, user_id, kind) values (v_id, v_uid, 'confirm');
  return v_id;
end $$;

-- ============ Подтверждение «у меня тоже» ============

create or replace function public.confirm_complaint(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare c complaints;
begin
  if not is_member() then raise exception 'not_member'; end if;
  select * into c from complaints where id = p_id and not hidden for update;
  if not found then raise exception 'not_found'; end if;
  if c.status = 'fixed' then raise exception 'already_fixed'; end if;
  insert into votes (complaint_id, user_id, kind) values (p_id, auth.uid(), 'confirm')
    on conflict do nothing;
  if not found then raise exception 'already_voted'; end if;
  update complaints set conf_count = conf_count + 1,
    status = case when status = 'collecting' and conf_count + 1 >= 2 then 'to_send' else status end,
    updated_at = now()
  where id = p_id;
end $$;

-- ============ Голоса о ремонте (геометка ≤150 м) ============
-- «Сделано плохо / снова сломалось» принимается только со свежим фото с места.

drop function if exists public.vote_repair(bigint, text, float8, float8);
create or replace function public.vote_repair(p_id bigint, p_kind text, p_lat float8, p_lng float8, p_photo_path text default null) returns text
language plpgsql security definer set search_path = public as $$
declare c complaints; v_dist float8;
begin
  if not is_member() then raise exception 'not_member'; end if;
  if p_kind not in ('fixed','notfixed','bad') then raise exception 'bad_kind'; end if;
  select * into c from complaints where id = p_id and not hidden for update;
  if not found then raise exception 'not_found'; end if;
  if p_lat is null or p_lng is null then raise exception 'no_location'; end if;
  v_dist := dist_m(c.lat, c.lng, p_lat, p_lng);
  if v_dist > 150 then raise exception 'too_far:%', round(v_dist); end if;

  if p_kind = 'fixed' and c.status not in ('sent','in_work','verifying') then raise exception 'wrong_status'; end if;
  if p_kind = 'notfixed' and c.status <> 'verifying' then raise exception 'wrong_status'; end if;
  if p_kind = 'bad' and c.status <> 'fixed' then raise exception 'wrong_status'; end if;
  if p_kind = 'bad' and (p_photo_path is null or p_photo_path not like auth.uid()::text || '/%') then
    raise exception 'photo_required';
  end if;

  insert into votes (complaint_id, user_id, kind, round, dist_m, photo_path)
    values (p_id, auth.uid(), p_kind, c.round, round(v_dist), case when p_kind = 'bad' then p_photo_path end)
    on conflict do nothing;
  if not found then raise exception 'already_voted'; end if;

  if p_kind = 'fixed' then
    update complaints set
      fixed_count = fixed_count + 1,
      status = case when fixed_count + 1 >= 3 then 'fixed' else 'verifying' end,
      verifying_since = coalesce(verifying_since, now()),
      fixed_at = case when fixed_count + 1 >= 3 then now() else fixed_at end,
      updated_at = now()
    where id = p_id returning status into c.status;
  elsif p_kind = 'notfixed' then
    update complaints set notfixed_count = notfixed_count + 1, updated_at = now() where id = p_id;
    if c.notfixed_count + 1 >= 2 then
      update complaints set
        status = case when answered_at is not null then 'in_work' else 'sent' end,
        round = round + 1, fixed_count = 0, notfixed_count = 0,
        verifying_since = null, akimat_reported = false
      where id = p_id returning status into c.status;
    end if;
  else -- bad: «сделано плохо» после зелёного
    update complaints set bad_count = bad_count + 1, bad_photo_path = p_photo_path, updated_at = now() where id = p_id;
    if c.bad_count + 1 >= 2 then
      update complaints set
        status = 'to_send', reopen_count = reopen_count + 1, round = round + 1,
        fixed_count = 0, notfixed_count = 0, bad_count = 0,
        verifying_since = null, fixed_at = null, akimat_reported = false,
        ticket_no = null, ticket_channel = null, sent_at = null, answered_at = null,
        answer_photo_path = null, answer_deadline = null, answer_note = null
      where id = p_id returning status into c.status;
    end if;
  end if;
  return coalesce(c.status, 'ok');
end $$;

-- ============ Номер обращения eOtinish / iKomek (вводится вручную) ============

create or replace function public.set_ticket(p_id bigint, p_channel text, p_no text) returns void
language plpgsql security definer set search_path = public as $$
declare c complaints;
begin
  if not is_member() then raise exception 'not_member'; end if;
  select * into c from complaints where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if c.author <> auth.uid() and not is_mod() then raise exception 'forbidden'; end if;
  if c.status not in ('collecting','to_send') and not is_mod() then raise exception 'wrong_status'; end if;
  if coalesce(trim(p_no),'') = '' then raise exception 'empty_ticket'; end if;
  update complaints set ticket_channel = p_channel, ticket_no = left(trim(p_no),60),
    status = case when status in ('collecting','to_send') then 'sent' else status end,
    sent_at = coalesce(sent_at, now()), updated_at = now()
  where id = p_id;
  insert into complaint_updates (complaint_id, author, kind, note)
    values (p_id, auth.uid(), 'ticket', coalesce(p_channel,'') || ' № ' || left(trim(p_no),60));
end $$;

-- ============ «Акимат ответил» (автор жалобы или модератор) ============
-- Автоматически узнать об ответе нельзя: у eOtinish / iKomek нет открытого API.
-- Поэтому автор или модератор отмечает ответ сам и прикладывает скриншот ответа.
-- С этого момента счётчик «дней без ответа» останавливается.

create or replace function public.mark_answered(p_id bigint, p_photo_path text, p_deadline date default null, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c complaints;
begin
  if not is_member() then raise exception 'not_member'; end if;
  select * into c from complaints where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if c.author <> auth.uid() and not is_mod() then raise exception 'forbidden'; end if;
  if c.status <> 'sent' then raise exception 'wrong_status'; end if;
  if p_photo_path is null or (p_photo_path not like auth.uid()::text || '/%' and not is_mod()) then
    raise exception 'answer_photo_required';
  end if;
  if p_deadline is not null and (p_deadline < current_date - 1 or p_deadline > current_date + 730) then
    raise exception 'bad_deadline';
  end if;
  update complaints set status = 'in_work', answered_at = now(),
    answer_photo_path = p_photo_path, answer_deadline = p_deadline,
    answer_note = left(nullif(trim(p_note), ''), 300), updated_at = now()
  where id = p_id;
  insert into complaint_updates (complaint_id, author, kind, note, photo_path)
    values (p_id, auth.uid(), 'answer', left(nullif(trim(p_note), ''), 300), p_photo_path);
end $$;

-- ============ «Акимат сообщил, что исправлено» (автор или модератор, со скриншотом) ============
-- Точка уходит на проверку жителями; зелёной её делают только 3 голоса «исправлено» с места.

create or replace function public.mark_reported(p_id bigint, p_photo_path text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c complaints;
begin
  if not is_member() then raise exception 'not_member'; end if;
  select * into c from complaints where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if c.author <> auth.uid() and not is_mod() then raise exception 'forbidden'; end if;
  if c.status not in ('sent','in_work') then raise exception 'wrong_status'; end if;
  if p_photo_path is null or (p_photo_path not like auth.uid()::text || '/%' and not is_mod()) then
    raise exception 'answer_photo_required';
  end if;
  update complaints set status = 'verifying', akimat_reported = true,
    answered_at = coalesce(answered_at, now()), verifying_since = coalesce(verifying_since, now()), updated_at = now()
  where id = p_id;
  insert into complaint_updates (complaint_id, author, kind, note, photo_path)
    values (p_id, auth.uid(), 'reported', left(nullif(trim(p_note), ''), 500), p_photo_path);
end $$;

-- ============ Фото / скрин / комментарий в историю жалобы ============

create or replace function public.add_update(p_id bigint, p_note text, p_photo_path text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c complaints;
begin
  if not is_member() then raise exception 'not_member'; end if;
  select * into c from complaints where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if c.author <> auth.uid() and not is_mod() then raise exception 'forbidden'; end if;
  if coalesce(trim(p_note), '') = '' and p_photo_path is null then raise exception 'empty_update'; end if;
  if p_photo_path is not null and p_photo_path not like auth.uid()::text || '/%' then raise exception 'bad_photo'; end if;
  if (select count(*) from complaint_updates where author = auth.uid() and created_at > now() - interval '1 day') >= 30 then
    raise exception 'rate_limit';
  end if;
  insert into complaint_updates (complaint_id, author, kind, note, photo_path)
    values (p_id, auth.uid(), 'note', left(nullif(trim(p_note), ''), 500), p_photo_path);
  update complaints set updated_at = now() where id = p_id;
end $$;

-- ============ Код восстановления кабинета ============
-- Аккаунт анонимный и живёт в браузере. Чтобы перенести кабинет на новый телефон,
-- житель сохраняет код восстановления. Храним только его хэш.

create or replace function public.new_recovery_code() returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not is_member() then raise exception 'not_member'; end if;
  v_code := upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 4) || '-' ||
                  substr(md5(gen_random_uuid()::text), 1, 4) || '-' ||
                  substr(md5(gen_random_uuid()::text), 1, 4));
  update profiles set recovery_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex') where id = auth.uid();
  return v_code;
end $$;

create or replace function public.recover_account(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare v_old profiles; v_new uuid := auth.uid(); v_hash text;
begin
  if v_new is null then raise exception 'not_signed_in'; end if;
  v_hash := encode(sha256(convert_to(upper(trim(p_code)), 'UTF8')), 'hex');
  select * into v_old from profiles where recovery_hash = v_hash for update;
  if not found then raise exception 'bad_recovery'; end if;
  if v_old.id = v_new then return v_old.role; end if;
  if v_old.banned then raise exception 'banned'; end if;
  -- Текущий профиль на этом устройстве (если есть) должен быть пустым
  if exists (select 1 from complaints where author = v_new) or exists (select 1 from votes where user_id = v_new) then
    raise exception 'device_not_empty';
  end if;
  delete from profiles where id = v_new;
  insert into profiles (id, role, consent_at, invite_code) values (v_new, v_old.role, now(), v_old.invite_code);
  update complaints set author = v_new where author = v_old.id;
  update votes set user_id = v_new where user_id = v_old.id;
  update complaint_updates set author = v_new where author = v_old.id;
  delete from profiles where id = v_old.id;
  return v_old.role;
end $$;

-- ============ Действия модератора ============

create or replace function public.mod_action(p_id bigint, p_action text, p_value text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_mod() then raise exception 'forbidden'; end if;
  if p_action = 'hide' then
    update complaints set hidden = true, hidden_reason = p_value where id = p_id;
  elsif p_action = 'unhide' then
    update complaints set hidden = false, hidden_reason = null where id = p_id;
  elsif p_action = 'approve_custom' then  -- подтвердить уровень опасности «Другого»
    update complaints set moderated = true, custom_sev = coalesce(p_value::int, custom_sev) where id = p_id and cat = 'other';
  elsif p_action = 'set_cat' then         -- перенести «Другое» в существующую категорию
    if public.cat_sev(p_value) is null or p_value = 'other' then raise exception 'bad_cat'; end if;
    update complaints set cat = p_value, moderated = true where id = p_id;
  elsif p_action = 'contractor' then
    update complaints set contractor = p_value where id = p_id;
  elsif p_action = 'warranty' then
    update complaints set warranty_until = p_value::date where id = p_id;
  elsif p_action = 'delete' then        -- удалить навсегда (с голосами и историей), с записью в журнал
    if coalesce(trim(p_value), '') = '' then raise exception 'reason_required'; end if;
    insert into deletion_log (complaint_id, actor, reason, snapshot)
      select id, auth.uid(), left(trim(p_value), 300), to_jsonb(c) from complaints c where id = p_id;
    delete from complaints where id = p_id;
    return;
  elsif p_action = 'remove_photo' then
    update complaints set photo_path = null where id = p_id;
  elsif p_action = 'ban_author' then
    update profiles set banned = true where id = (select author from complaints where id = p_id);
    update complaints set hidden = true, hidden_reason = coalesce(p_value,'бан автора')
      where author = (select author from complaints where id = p_id);
  else
    raise exception 'bad_action';
  end if;
  update complaints set updated_at = now() where id = p_id;
end $$;

-- ============ Удаление своих данных (право субъекта ПД) ============

create or replace function public.delete_my_data() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  -- Фото удаляет само приложение через Storage API до вызова этой функции
  -- (Supabase запрещает удалять файлы прямым SQL).
  delete from profiles where id = auth.uid();   -- каскадом удалит жалобы и голоса
end $$;

-- ============ Доступ (RLS) ============

alter table public.profiles     enable row level security;
alter table public.invite_codes enable row level security;  -- без политик: коды не видны клиенту
alter table public.complaints   enable row level security;
alter table public.votes        enable row level security;
alter table public.complaint_updates enable row level security;
alter table public.deletion_log enable row level security;

drop policy if exists deletion_log_mod on public.deletion_log;
create policy deletion_log_mod on public.deletion_log for select using (public.is_mod());

drop policy if exists updates_read on public.complaint_updates;
create policy updates_read on public.complaint_updates for select
  using (exists (select 1 from public.complaints c where c.id = complaint_id));

drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for select using (id = auth.uid() or public.is_mod());

drop policy if exists complaints_read on public.complaints;
create policy complaints_read on public.complaints for select
  using (not hidden or author = auth.uid() or public.is_mod());

drop policy if exists votes_read on public.votes;
create policy votes_read on public.votes for select using (user_id = auth.uid() or public.is_mod());

-- Писать в таблицы напрямую нельзя никому: только через функции выше.
revoke insert, update, delete on public.profiles, public.complaints, public.votes, public.invite_codes, public.complaint_updates from anon, authenticated;
grant select on public.complaint_updates to anon, authenticated;
revoke all on public.deletion_log from anon, authenticated;
grant select on public.deletion_log to authenticated;
revoke all on public.invite_codes from anon, authenticated;
grant select on public.complaints to anon, authenticated;
grant select on public.profiles, public.votes to authenticated;

revoke execute on function public.mark_answered(bigint,text,date,text), public.mark_reported(bigint,text,text),
  public.add_update(bigint,text,text), public.new_recovery_code(), public.recover_account(text) from public, anon;
grant execute on function public.mark_answered(bigint,text,date,text), public.mark_reported(bigint,text,text),
  public.add_update(bigint,text,text), public.new_recovery_code(), public.recover_account(text) to authenticated;
revoke execute on function public.join_pilot(text), public.create_complaint(text,text,text,int,text,text,float8,float8,text),
  public.confirm_complaint(bigint), public.vote_repair(bigint,text,float8,float8,text), public.set_ticket(bigint,text,text),
  public.mod_action(bigint,text,text), public.delete_my_data() from public, anon;
grant execute on function public.join_pilot(text), public.create_complaint(text,text,text,int,text,text,float8,float8,text),
  public.confirm_complaint(bigint), public.vote_repair(bigint,text,float8,float8,text), public.set_ticket(bigint,text,text),
  public.mod_action(bigint,text,text), public.delete_my_data() to authenticated;

-- ============ Хранилище фото ============
-- Публичное чтение, загрузка только участником пилота и только в свою папку <user_id>/...
-- Фото перед загрузкой пережимается в браузере: EXIF (включая GPS и модель телефона) удаляется.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 3145728, array['image/jpeg','image/webp'])
on conflict (id) do nothing;

drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists photos_delete_own on storage.objects;
create policy photos_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists photos_delete_mod on storage.objects;
create policy photos_delete_mod on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_mod());

drop policy if exists photos_read on storage.objects;
create policy photos_read on storage.objects for select using (bucket_id = 'photos');

-- ============ Инвайт-коды ============
-- Создаются один раз случайными. Чтобы добавить свой: insert into invite_codes (code) values ('ASTANA2026');

insert into public.invite_codes (code, role, max_uses)
select 'QALA-' || upper(substr(md5(random()::text), 1, 6)), 'resident', 200
where not exists (select 1 from public.invite_codes where role = 'resident');

insert into public.invite_codes (code, role, max_uses)
select 'MOD-' || upper(substr(md5(random()::text), 1, 8)), 'moderator', 3
where not exists (select 1 from public.invite_codes where role = 'moderator');

select code, role, max_uses, uses from public.invite_codes order by role desc;
