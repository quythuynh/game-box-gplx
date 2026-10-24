-- Chạy 1 lần trong Supabase SQL Editor: Sinh tồn bốc ngẫu nhiên + tuỳ chọn loại câu
create or replace function gp_pick_questions(p_mode text) returns int[]
language plpgsql as $$
declare
  chosen int[];
  plan int[] := array[9,1,3,2,9,6];
  c int; have int; need int;
  base text := split_part(coalesce(p_mode,''), '~', 1);
  kind text := coalesce(substring(p_mode from 'k=([a-z]+)'), 'all');
  n_img int;
begin
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
