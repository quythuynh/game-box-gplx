const store = require('./store');
const questionsData = require('../../data/questions_600_bca.json');

const TTL = 60 * 60 * 6;
const STALE_MS = 30000;
const MAX_EVENTS = 300;
const MAX_PLAYERS = 6;
const FX_PER_SEC = 6;
const PLAYER_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
const byId = new Map(questionsData.map(q => [q.id, q]));

const k = {
  room: c => `room:${c}`,
  players: c => `room:${c}:players`,
  seen: c => `room:${c}:seen`,
  events: c => `room:${c}:events`,
  seq: c => `room:${c}:seq`
};

const parse = s => (s == null ? null : (typeof s === 'string' ? JSON.parse(s) : s));

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function sample(arr, n) {
  return [...arr].sort(() => 0.5 - Math.random()).slice(0, n);
}

function generate30Questions(mode = 'standard') {
  if (mode === 'critical') return sample(questionsData.filter(q => q.is_critical), 30);
  if (mode === 'signs') return sample(questionsData.filter(q => q.chapter === 5 || q.chapter === 6), 30);

  const ch = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  questionsData.forEach(q => { if (ch[q.chapter]) ch[q.chapter].push(q); });
  const pickedCritical = sample(questionsData.filter(q => q.is_critical), 2);
  const pickedIds = new Set(pickedCritical.map(q => q.id));
  const plan = { 1: 9, 2: 1, 3: 3, 4: 2, 5: 9, 6: 6 };
  const exam = [...pickedCritical];
  for (let c = 1; c <= 6; c++) {
    const have = exam.filter(q => q.chapter === c).length;
    const chosen = sample(ch[c].filter(q => !pickedIds.has(q.id)), Math.max(0, plan[c] - have));
    chosen.forEach(q => { pickedIds.add(q.id); exam.push(q); });
  }
  exam.sort((a, b) => a.id - b.id);
  return exam.slice(0, 30);
}

async function getRoom(code) {
  return parse(await store.get(k.room(code)));
}
const saveRoom = (room) => store.set(k.room(room.code), JSON.stringify(room));

async function getPlayers(code) {
  const raw = (await store.hgetall(k.players(code))) || {};
  const players = {};
  Object.keys(raw).forEach(id => { players[id] = parse(raw[id]); });
  return players;
}
const getPlayer = async (code, id) => parse(await store.hget(k.players(code), id));
const savePlayer = (code, p) => store.hset(k.players(code), { [p.id]: JSON.stringify(p) });

async function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    mode: room.mode,
    timeLimit: room.timeLimit,
    startedAt: room.startedAt,
    players: await getPlayers(room.code)
  };
}

// except: id người gửi sẽ không nhận sự kiện (tương đương socket.to(room).emit)
async function emit(code, ev, data, except = null) {
  const seq = await store.incr(k.seq(code));
  await store.zadd(k.events(code), { score: seq, member: JSON.stringify({ seq, ev, data, except }) });
  if (seq % 50 === 0) await store.zremrangebyrank(k.events(code), 0, -MAX_EVENTS - 1);
  return seq;
}

function newPlayer(id, name, avatar, color, isHost, fallbackName) {
  return {
    id, name: name ? String(name).trim().slice(0, 20) : fallbackName, avatar, color, isHost,
    isReady: isHost, currentQ: 0, answers: {}, submitted: false, submitTime: null,
    score: 0, passed: false, failedCritical: false
  };
}

const clientQuestions = list => list.map(q => ({
  id: q.id, chapter: q.chapter, chapter_name: q.chapter_name, question: q.question,
  image: q.image, options: q.options, is_critical: q.is_critical,
  correct_option: q.correct_option, explanation: q.explanation
}));

const roomQuestions = room => (room.questionIds || []).map(id => byId.get(id));

async function finishGame(room) {
  room.status = 'ended';
  room.endedAt = Date.now();
  await saveRoom(room);
  const players = Object.values(await getPlayers(room.code)).sort((a, b) => {
    if (a.passed !== b.passed) return a.passed ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return (a.submitTime || 9999) - (b.submitTime || 9999);
  });
  await emit(room.code, 'game-ended', {
    rankings: players,
    room: await publicState(room),
    questions: roomQuestions(room)
  });
}

// ---- Handlers: trả về kết quả "callback" cho client ----
const handlers = {
  async 'create-room'({ name, avatar, mode = 'standard', timeLimit = 1200 }, pid) {
    let code = generateRoomCode();
    while (await getRoom(code)) code = generateRoomCode();
    const room = {
      code, hostId: pid, status: 'lobby', mode,
      timeLimit: parseInt(timeLimit, 10) || 1200,
      startedAt: null, endedAt: null, questionIds: []
    };
    const player = newPlayer(pid, name, avatar || '🏎️', PLAYER_COLORS[0], true, 'Người chơi 1');
    const seq = Number(await store.get(k.seq(code))) || 0;
    await Promise.all([saveRoom(room), savePlayer(code, player), store.hset(k.seen(code), { [pid]: String(Date.now()) })]);
    await Promise.all([store.expire(k.room(code), TTL), store.expire(k.players(code), TTL), store.expire(k.seen(code), TTL), store.expire(k.events(code), TTL), store.expire(k.seq(code), TTL)]);
    await emit(code, 'room-state', await publicState(room));
    return { success: true, roomCode: code, player, seq };
  },

  async 'join-room'({ roomCode, name, avatar }, pid) {
    const code = (roomCode || '').trim().toUpperCase();
    const room = code && await getRoom(code);
    if (!room) return { success: false, message: 'Phòng không tồn tại!' };
    const players = await getPlayers(code);
    if (!players[pid]) {
      const count = Object.keys(players).length;
      if (count >= MAX_PLAYERS) return { success: false, message: `Phòng đã đầy (tối đa ${MAX_PLAYERS} người)!` };
      if (room.status === 'playing') return { success: false, message: 'Trận đấu đang diễn ra, không thể tham gia!' };
      players[pid] = newPlayer(pid, name, avatar || ['🚗', '🚙', '🚕', '🏎️', '🚓', '🚌'][count % 6],
        PLAYER_COLORS[count % PLAYER_COLORS.length], false, `Người chơi ${count + 1}`);
      await savePlayer(code, players[pid]);
    }
    const seq = Number(await store.get(k.seq(code))) || 0;
    await store.hset(k.seen(code), { [pid]: String(Date.now()) });
    await emit(code, 'room-state', await publicState(room));
    const result = { success: true, roomCode: code, player: players[pid], seq };
    if (room.status === 'playing') {
      // Người chơi vào lại giữa trận: gửi kèm đề và trạng thái để khôi phục
      result.resume = { room: await publicState(room), questions: clientQuestions(roomQuestions(room)) };
    }
    return result;
  },

  // Khán giả: vào xem phòng (kể cả khi đang thi đấu) mà không thành người chơi
  async 'spectate-room'({ roomCode }, pid) {
    const code = (roomCode || '').trim().toUpperCase();
    const room = code && await getRoom(code);
    if (!room) return { success: false, message: 'Phòng không tồn tại!' };
    const seq = Number(await store.get(k.seq(code))) || 0;
    await store.hset(k.seen(code), { [pid]: String(Date.now()) });
    const result = { success: true, spectator: true, roomCode: code, seq, room: await publicState(room) };
    if (room.status === 'playing') {
      result.resume = { room: result.room, questions: clientQuestions(roomQuestions(room)) };
    }
    return result;
  },

  async 'toggle-ready'({ isReady }, pid, code) {
    const p = await getPlayer(code, pid);
    if (!p) return;
    p.isReady = Boolean(isReady);
    await savePlayer(code, p);
    await emit(code, 'room-state', await publicState(await getRoom(code)));
  },

  async 'update-settings'({ mode, timeLimit }, pid, code) {
    const room = await getRoom(code);
    if (!room || room.hostId !== pid || room.status !== 'lobby') return;
    if (mode) room.mode = mode;
    if (timeLimit) room.timeLimit = parseInt(timeLimit, 10);
    await saveRoom(room);
    await emit(code, 'room-state', await publicState(room));
  },

  async 'start-game'(_, pid, code) {
    const room = await getRoom(code);
    if (!room || room.hostId !== pid || room.status !== 'lobby') return;
    const questions = generate30Questions(room.mode);
    room.questionIds = questions.map(q => q.id);
    room.status = 'playing';
    room.startedAt = Date.now();
    const players = await getPlayers(code);
    await saveRoom(room);
    await Promise.all(Object.values(players).map(p => {
      Object.assign(p, { answers: {}, currentQ: 0, submitted: false, score: 0, submitTime: null, passed: false, failedCritical: false });
      return savePlayer(code, p);
    }));
    await emit(code, 'game-started', {
      room: await publicState(room),
      questions: clientQuestions(questions)
    });
  },

  // Client đã biết tên/avatar/màu từ room-state nên không cần tra cứu người chơi (đỡ 1 lần đọc Redis mỗi lần di chuột)
  async 'cursor-move'({ xPercent, yPercent, qIndex }, pid, code) {
    await emit(code, 'player-cursor', { playerId: pid, x: xPercent, y: yPercent, qIndex }, pid);
  },

  // Kênh relay cho tính năng phía client (sẵn sàng, chat, đếm ngược, điểm...). Không lưu trạng thái.
  async 'fx'(data, pid, code) {
    const t = typeof data.t === 'string' ? data.t.slice(0, 16) : '';
    if (!t || JSON.stringify(data).length > 600) return;
    // Giới hạn tốc độ: tối đa FX_PER_SEC tin/giây/người để chống spam chat, chọc...
    const bucket = `room:${code}:rl:${pid}:${Math.floor(Date.now() / 1000)}`;
    const n = await store.incr(bucket);
    if (n === 1) await store.expire(bucket, 5);
    if (n > FX_PER_SEC) return;
    await emit(code, 'fx', Object.assign({}, data, { t, from: pid }), pid);
  },

  async 'select-answer'({ qIndex, optionIndex }, pid, code) {
    const room = await getRoom(code);
    if (!room || room.status !== 'playing') return;
    const p = await getPlayer(code, pid);
    if (!p || p.submitted) return;
    p.answers[qIndex] = optionIndex;
    await savePlayer(code, p);
    await emit(code, 'player-progress-updated', {
      playerId: pid, name: p.name, color: p.color, qIndex,
      optionIndex,
      totalAnswered: Object.keys(p.answers).length,
      answeredList: Object.keys(p.answers).map(Number)
    }, pid);
  },

  async 'navigate-question'({ qIndex }, pid, code) {
    const p = await getPlayer(code, pid);
    if (!p) return;
    p.currentQ = qIndex;
    await savePlayer(code, p);
    await emit(code, 'player-navigated', { playerId: pid, qIndex }, pid);
  },

  async 'send-reaction'({ emoji }, pid, code) {
    const p = await getPlayer(code, pid);
    if (!p) return;
    await emit(code, 'player-reaction', { playerId: pid, name: p.name, avatar: p.avatar, color: p.color, emoji });
  },

  async 'submit-exam'(_, pid, code) {
    const room = await getRoom(code);
    if (!room || room.status !== 'playing') return;
    const p = await getPlayer(code, pid);
    if (!p || p.submitted) return;
    p.submitted = true;
    p.submitTime = Math.round((Date.now() - room.startedAt) / 1000);
    let score = 0;
    let failedCritical = false;
    roomQuestions(room).forEach((q, idx) => {
      const chosen = p.answers[idx];
      if (chosen === q.correct_option) score++;
      else if (q.is_critical && chosen !== undefined) failedCritical = true;
    });
    p.score = score;
    p.failedCritical = failedCritical;
    p.passed = score >= 27 && !failedCritical;
    await savePlayer(code, p);
    await emit(code, 'player-submitted', {
      playerId: pid, name: p.name, score, passed: p.passed, failedCritical,
      submitTime: p.submitTime, answers: p.answers
    });
    if (Object.values(await getPlayers(code)).every(x => x.submitted)) await finishGame(room);
  },

  async 'restart-game'(_, pid, code) {
    const room = await getRoom(code);
    if (!room || room.hostId !== pid) return;
    room.status = 'lobby';
    room.questionIds = [];
    room.startedAt = null;
    room.endedAt = null;
    await saveRoom(room);
    const players = await getPlayers(code);
    await Promise.all(Object.values(players).map(p => {
      Object.assign(p, { answers: {}, currentQ: 0, submitted: false, score: 0, submitTime: null, passed: false, failedCritical: false });
      return savePlayer(code, p);
    }));
    await emit(code, 'room-restarted', await publicState(room));
  },

  async 'leave-room'(_, pid, code) {
    await removePlayer(code, pid);
  }
};

async function removePlayer(code, pid) {
  // Chỉ instance xoá được người chơi mới xử lý tiếp (tránh xử lý trùng)
  const p = await getPlayer(code, pid);
  const removed = await store.hdel(k.players(code), pid);
  await store.hdel(k.seen(code), pid);
  if (!removed) return;
  const room = await getRoom(code);
  if (!room) return;
  await emit(code, 'player-left', { playerId: pid, name: p ? p.name : 'Người chơi' }, pid);
  const remaining = Object.values(await getPlayers(code));
  if (remaining.length === 0) {
    await store.del(k.room(code), k.players(code), k.seen(code), k.events(code), k.seq(code));
    return;
  }
  if (room.hostId === pid) {
    room.hostId = remaining[0].id;
    remaining[0].isHost = true;
    await Promise.all([saveRoom(room), savePlayer(code, remaining[0])]);
  }
  await emit(code, 'room-state', await publicState(room));
  if (room.status === 'playing' && remaining.every(x => x.submitted)) await finishGame(room);
}

async function handle(event, data, pid, code) {
  const fn = handlers[event];
  if (!fn) return { success: false, message: 'Sự kiện không hợp lệ' };
  const needsRoom = !['create-room', 'join-room', 'spectate-room'].includes(event);
  if (needsRoom) {
    if (!code || !(await getRoom(code))) return { success: false, message: 'Phòng không tồn tại' };
  }
  return fn(data || {}, pid, code);
}

// Trả về các sự kiện mới cho người chơi và dọn người chơi mất kết nối
async function poll(code, pid, since) {
  const [, rawEvents, seen] = await Promise.all([
    store.hset(k.seen(code), { [pid]: String(Date.now()) }),
    store.zrange(k.events(code), `(${since}`, '+inf', { byScore: true }),
    store.hgetall(k.seen(code))
  ]);
  const now = Date.now();
  await Promise.all(Object.keys(seen || {})
    .filter(id => id !== pid && now - Number(seen[id]) > STALE_MS)
    .map(id => removePlayer(code, id)));

  const events = (rawEvents || []).map(parse).filter(e => e.except !== pid);
  const last = (rawEvents || []).length ? parse(rawEvents[rawEvents.length - 1]).seq : since;
  return { events, seq: Math.max(Number(since), last) };
}

module.exports = { handle, poll, getRoom, generate30Questions, questionsData };
