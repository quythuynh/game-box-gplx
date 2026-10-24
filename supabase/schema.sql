-- Schema cho game GPLX realtime trên Supabase.
-- Chạy file này TRƯỚC trong Supabase → SQL Editor, rồi chạy questions_seed.sql.
-- Bảo mật: client chỉ ĐỌC bảng; mọi thao tác ghi đi qua các hàm gp_* (security definer).

create table if not exists questions (
  id int primary key,
  chapter int not null,
  chapter_name text,
  question text not null,
  image text,
  options jsonb not null,
  correct_option int not null,
  is_critical boolean not null default false,
  explanation text
);

create table if not exists rooms (
  code text primary key,
  host_id text not null,
  status text not null default 'lobby',          -- lobby | playing | ended
  mode text not null default 'standard',
  time_limit int not null default 1200,
  started_at timestamptz,
  ended_at timestamptz,
  question_ids int[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists players (
  room_code text not null references rooms(code) on delete cascade,
  id text not null,
  name text not null,
  avatar text not null,
  color text not null,
  is_host boolean not null default false,
  is_ready boolean not null default false,
  submitted boolean not null default false,
  submit_time int,
  score int not null default 0,
  passed boolean not null default false,
  failed_critical boolean not null default false,
  answered int not null default 0,
  joined_at timestamptz not null default now(),
  primary key (room_code, id)
);

-- Đáp án đã chọn: KHÔNG ai đọc được trực tiếp (không có policy select)
create table if not exists player_answers (
  room_code text not null,
  player_id text not null,
  answers jsonb not null default '{}'::jsonb,
  primary key (room_code, player_id),
  foreign key (room_code, player_id) references players(room_code, id) on delete cascade
);

alter table questions enable row level security;
alter table rooms enable row level security;
alter table players enable row level security;
alter table player_answers enable row level security;

drop policy if exists "read questions" on questions;
drop policy if exists "read rooms" on rooms;
drop policy if exists "read players" on players;
create policy "read questions" on questions for select using (true);
create policy "read rooms" on rooms for select using (true);
create policy "read players" on players for select using (true);

grant select on questions, rooms, players to anon, authenticated;

-- ---------- Helpers ----------
create or replace function gp_pick_questions(p_mode text) returns int[]
language plpgsql as $$
declare
  chosen int[];
  plan int[] := array[9,1,3,2,9,6];
  c int; have int; need int;
  base text := split_part(coalesce(p_mode,''), '~', 1);
  kind text := coalesce(substring(p_mode from 'k=([a-z]+)'), 'all');
  n_img int;
  cnt int := least(30, greatest(10, coalesce(substring(p_mode from 'c=([0-9]+)')::int, 20)));
  n_mix int;
  res int[];
begin
  if base in ('survival', 'survival2') and kind = 'mix' then
    -- Đúng 70% hình / 30% chữ trong số câu thật sự chơi (cnt); phần còn lại của đề lấy ngẫu nhiên
    n_mix := round(cnt * 0.7);
    with u as (
      select distinct on (question, coalesce(image, '')) id, (image is not null) as has_img
      from questions order by question, coalesce(image, ''), random()
    ), h as (
      (select id from u where has_img order by random() limit n_mix)
      union all
      (select id from u where not has_img order by random() limit cnt - n_mix)
    ), t as (
      select id from u where id not in (select id from h) order by random() limit 30 - cnt
    )
    select (select array_agg(id order by random()) from h) || coalesce((select array_agg(id order by random()) from t), '{}')
    into res;
    return res;
  end if;
  if base in ('survival', 'survival2') then
    -- Bỏ câu trùng cả đề lẫn ảnh; thứ tự bốc ngẫu nhiên (không sắp theo id)
    n_img := case kind when 'img' then 30 when 'text' then 0 when 'mix' then 21 else 30 end;
    return array(
      with u as (
        select distinct on (question, coalesce(image, '')) id, chapter, (image is not null) as has_img
        from questions order by question, coalesce(image, ''), random()
      ), pick as (
        select id from u where kind = 'all'
        union all
        select id from u where kind = 'signs' and chapter in (5, 6)
        union all
        select id from u where kind = 'law' and chapter <= 4
        union all
        (select id from u where kind in ('img','text','mix') and has_img order by random() limit n_img)
        union all
        (select id from u where kind in ('img','text','mix') and not has_img order by random() limit 30 - n_img)
      )
      select id from (select id from pick order by random() limit 30) z order by random()
    );
  end if;
  if p_mode = 'critical' then
    return array(select id from questions where is_critical order by random() limit 30);
  elsif p_mode = 'signs' then
    return array(select id from questions where chapter in (5,6) order by random() limit 30);
  end if;
  chosen := array(select id from questions where is_critical order by random() limit 2);
  for c in 1..6 loop
    select count(*) into have from questions where id = any(chosen) and chapter = c;
    need := greatest(0, plan[c] - have);
    chosen := chosen || array(
      select id from questions where chapter = c and not (id = any(chosen)) order by random() limit need);
  end loop;
  return array(select id from questions where id = any(chosen) order by id limit 30);
end $$;

create or replace function gp_player_json(p players) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'avatar', p.avatar, 'color', p.color,
    'isHost', p.is_host, 'isReady', p.is_ready, 'submitted', p.submitted,
    'submitTime', p.submit_time, 'score', p.score, 'passed', p.passed,
    'failedCritical', p.failed_critical, 'currentQ', 0, 'answers', '{}'::jsonb)
$$;

-- ---------- Hàm nghiệp vụ ----------
create or replace function gp_create_room(p_pid text, p_name text, p_avatar text, p_mode text, p_time int)
returns jsonb language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text; i int; pl players;
begin
  if coalesce(p_pid,'') = '' then return jsonb_build_object('success', false, 'message', 'Thiếu mã người chơi'); end if;
  loop
    code := '';
    for i in 1..4 loop code := code || substr(chars, 1 + floor(random()*length(chars))::int, 1); end loop;
    exit when not exists (select 1 from rooms where rooms.code = code);
  end loop;
  -- dọn phòng cũ > 6 giờ
  delete from rooms where created_at < now() - interval '6 hours';

  insert into rooms(code, host_id, mode, time_limit)
  values (code, p_pid, coalesce(nullif(p_mode,''),'standard'), coalesce(nullif(p_time,0),1200));
  insert into players(room_code, id, name, avatar, color, is_host, is_ready)
  values (code, p_pid, left(coalesce(nullif(trim(p_name),''),'Người chơi 1'),20), coalesce(nullif(p_avatar,''),'🏎️'), '#3b82f6', true, true)
  returning * into pl;
  insert into player_answers(room_code, player_id) values (code, p_pid);
  return jsonb_build_object('success', true, 'roomCode', code, 'player', gp_player_json(pl));
end $$;

create or replace function gp_join_room(p_pid text, p_code text, p_name text, p_avatar text)
returns jsonb language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare
  rm rooms; cnt int; pl players; code text := upper(trim(coalesce(p_code,'')));
  colors text[] := array['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899'];
  avatars text[] := array['🚗','🚙','🚕','🏎️','🚓','🚌'];
begin
  select * into rm from rooms where rooms.code = code;
  if not found then return jsonb_build_object('success', false, 'message', 'Phòng không tồn tại!'); end if;
  select * into pl from players where room_code = code and id = p_pid;
  if found then
    return jsonb_build_object('success', true, 'roomCode', code, 'player', gp_player_json(pl));
  end if;
  select count(*) into cnt from players where room_code = code;
  if cnt >= 6 then return jsonb_build_object('success', false, 'message', 'Phòng đã đầy (tối đa 6 người)!'); end if;
  if rm.status = 'playing' then return jsonb_build_object('success', false, 'message', 'Trận đấu đang diễn ra, không thể tham gia!'); end if;

  insert into players(room_code, id, name, avatar, color, is_host)
  values (code, p_pid,
    left(coalesce(nullif(trim(p_name),''), 'Người chơi ' || (cnt+1)),20),
    coalesce(nullif(p_avatar,''), avatars[1 + (cnt % 6)]),
    colors[1 + (cnt % 6)], false)
  returning * into pl;
  insert into player_answers(room_code, player_id) values (code, p_pid);
  return jsonb_build_object('success', true, 'roomCode', code, 'player', gp_player_json(pl));
end $$;

create or replace function gp_start_game(p_pid text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rm rooms;
begin
  select * into rm from rooms where code = p_code for update;
  if not found or rm.host_id <> p_pid or rm.status <> 'lobby' then
    return jsonb_build_object('success', false);
  end if;
  update players set submitted=false, submit_time=null, score=0, passed=false, failed_critical=false, answered=0
    where room_code = p_code;
  update player_answers set answers = '{}'::jsonb where room_code = p_code;
  update rooms set status='playing', started_at=now(), ended_at=null, question_ids=gp_pick_questions(rm.mode)
    where code = p_code;
  return jsonb_build_object('success', true);
end $$;

create or replace function gp_select_answer(p_pid text, p_code text, p_q int, p_opt int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cnt int; sub boolean; st text;
begin
  select status into st from rooms where code = p_code;
  select submitted into sub from players where room_code = p_code and id = p_pid;
  if st is distinct from 'playing' or sub is distinct from false then return jsonb_build_object('success', false); end if;
  update player_answers set answers = jsonb_set(answers, array[p_q::text], to_jsonb(p_opt))
    where room_code = p_code and player_id = p_pid
    returning (select count(*) from jsonb_object_keys(answers)) into cnt;
  update players set answered = coalesce(cnt,0) where room_code = p_code and id = p_pid;
  return jsonb_build_object('success', true, 'totalAnswered', cnt);
end $$;

create or replace function gp_finish_if_done(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from rooms where code = p_code and status = 'playing')
     and not exists (select 1 from players where room_code = p_code and not submitted) then
    update rooms set status='ended', ended_at=now() where code = p_code;
  end if;
end $$;

create or replace function gp_submit(p_pid text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rm rooms; ans jsonb; sc int := 0; crit boolean := false; i int; q questions; chosen int;
begin
  select * into rm from rooms where code = p_code;
  if not found or rm.status <> 'playing' then return jsonb_build_object('success', false); end if;
  if exists (select 1 from players where room_code = p_code and id = p_pid and submitted) then
    return jsonb_build_object('success', false);
  end if;
  select answers into ans from player_answers where room_code = p_code and player_id = p_pid;
  for i in 0..coalesce(array_length(rm.question_ids,1),0)-1 loop
    select * into q from questions where id = rm.question_ids[i+1];
    chosen := (ans ->> i::text)::int;
    if chosen is not null and chosen = q.correct_option then sc := sc + 1;
    elsif q.is_critical and chosen is not null then crit := true; end if;
  end loop;
  update players set submitted=true, score=sc, failed_critical=crit, passed=(sc >= 27 and not crit),
    submit_time = round(extract(epoch from (now() - rm.started_at)))::int
    where room_code = p_code and id = p_pid;
  perform gp_finish_if_done(p_code);
  return jsonb_build_object('success', true, 'score', sc);
end $$;

create or replace function gp_restart(p_pid text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from rooms where code = p_code and host_id = p_pid) then
    return jsonb_build_object('success', false);
  end if;
  update players set submitted=false, submit_time=null, score=0, passed=false, failed_critical=false, answered=0
    where room_code = p_code;
  update player_answers set answers = '{}'::jsonb where room_code = p_code;
  update rooms set status='lobby', question_ids='{}', started_at=null, ended_at=null where code = p_code;
  return jsonb_build_object('success', true);
end $$;

create or replace function gp_leave(p_pid text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rm rooms; nxt text;
begin
  delete from players where room_code = p_code and id = p_pid;
  if not found then return jsonb_build_object('success', true); end if;
  select * into rm from rooms where code = p_code;
  if not found then return jsonb_build_object('success', true); end if;
  select id into nxt from players where room_code = p_code order by joined_at limit 1;
  if nxt is null then
    delete from rooms where code = p_code;
  else
    if rm.host_id = p_pid then
      update rooms set host_id = nxt where code = p_code;
      update players set is_host = (id = nxt) where room_code = p_code;
    end if;
    perform gp_finish_if_done(p_code);
  end if;
  return jsonb_build_object('success', true);
end $$;

-- Câu hỏi của phòng (kèm đáp án đúng, giống bản gốc để giữ chế độ "Học tập")
create or replace function gp_get_questions(p_code text) returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(q) order by array_position(r.question_ids, q.id)), '[]'::jsonb)
  from rooms r join questions q on q.id = any(r.question_ids)
  where r.code = p_code and r.status in ('playing','ended')
$$;

-- Kết quả: chỉ trả khi trận đã kết thúc (lúc này mới lộ đáp án của từng người)
create or replace function gp_get_results(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  if not exists (select 1 from rooms where code = p_code and status = 'ended') then return null; end if;
  select jsonb_build_object(
    'questions', gp_get_questions(p_code),
    'rankings', coalesce(jsonb_agg(
      (gp_player_json(p) || jsonb_build_object('answers', coalesce(a.answers, '{}'::jsonb)))
      order by p.passed desc, p.score desc, coalesce(p.submit_time, 9999) asc), '[]'::jsonb))
  into res
  from players p left join player_answers a on a.room_code = p.room_code and a.player_id = p.id
  where p.room_code = p_code;
  return res;
end $$;

revoke all on function gp_create_room, gp_join_room, gp_start_game, gp_select_answer, gp_submit,
  gp_restart, gp_leave, gp_get_questions, gp_get_results, gp_finish_if_done from public;
grant execute on function gp_create_room, gp_join_room, gp_start_game, gp_select_answer, gp_submit,
  gp_restart, gp_leave, gp_get_questions, gp_get_results to anon, authenticated;

-- Bật Realtime cho phòng và người chơi
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table rooms; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table players; exception when duplicate_object then null; end;
  end if;
end $$;
