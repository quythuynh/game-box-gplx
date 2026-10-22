-- Nâng giới hạn phòng từ 4 lên 6 người.
-- Chạy file này 1 lần trong Supabase → SQL Editor (chỉ thay hàm gp_join_room, không đụng dữ liệu).
-- Không cần thay đổi bảng hay cột nào.

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

grant execute on function gp_join_room to anon, authenticated;
