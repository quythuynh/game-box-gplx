// Shim tương thích API socket.io (emit/on) chạy trên Supabase:
//  - Ghi trạng thái: RPC gp_* (Postgres functions)
//  - Đồng bộ phòng/người chơi: Postgres Changes + refresh định kỳ dự phòng
//  - Chuột, cảm xúc, tiến độ: Realtime Broadcast; rời phòng: Presence
(function () {
  const URL = window.SUPABASE_URL;
  const KEY = window.SUPABASE_ANON_KEY;
  const FALLBACK_REFRESH_MS = 4000;

  function getPlayerId() {
    try {
      let id = sessionStorage.getItem('gplx_pid');
      if (!id) {
        id = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        sessionStorage.setItem('gplx_pid', id);
      }
      return id;
    } catch (e) {
      return 'p_' + Math.random().toString(36).slice(2, 12);
    }
  }

  function createSocket() {
    const sb = window.supabase.createClient(URL, KEY, { realtime: { params: { eventsPerSecond: 20 } } });
    const handlers = {};
    const sock = {
      id: getPlayerId(),
      connected: false,
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
      _fire(ev, data) { (handlers[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(ev, e); } }); }
    };

    let room = null;        // mã phòng
    let me = null;          // thông tin người chơi của mình
    let channel = null;
    let prev = null;        // { status, ids:Set, submitted:Set }
    let refreshing = false;
    let refreshAgain = false;
    let timer = null;
    let answered = {};      // câu đã trả lời của mình (để gửi tiến độ)

    async function rpc(fn, args) {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw error;
      return data;
    }

    function playerObj(p) {
      return {
        id: p.id, name: p.name, avatar: p.avatar, color: p.color, isHost: p.is_host,
        isReady: p.is_ready, currentQ: 0, answers: {}, submitted: p.submitted,
        submitTime: p.submit_time, score: p.score, passed: p.passed,
        failedCritical: p.failed_critical, totalAnswered: p.answered
      };
    }

    function roomState(r, players) {
      const map = {};
      players.forEach(p => { map[p.id] = playerObj(p); });
      return {
        code: r.code, hostId: r.host_id, status: r.status, mode: r.mode, timeLimit: r.time_limit,
        startedAt: r.started_at ? Date.parse(r.started_at) : null, players: map
      };
    }

    async function refresh() {
      if (!room) return;
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        const [rr, pp] = await Promise.all([
          sb.from('rooms').select('*').eq('code', room).maybeSingle(),
          sb.from('players').select('*').eq('room_code', room).order('joined_at')
        ]);
        if (rr.error || pp.error) throw (rr.error || pp.error);
        if (!rr.data) { stop(); sock._fire('disconnect'); return; }
        const state = roomState(rr.data, pp.data || []);
        const ids = new Set(Object.keys(state.players));
        const submitted = new Set(Object.values(state.players).filter(p => p.submitted).map(p => p.id));

        if (!prev) {
          prev = { status: state.status, ids, submitted };
          sock._fire('room-state', state);
          if (state.status === 'playing') await startGame(state);
          return;
        }

        const left = [...prev.ids].filter(id => !ids.has(id));
        left.forEach(id => sock._fire('player-left', { playerId: id, name: '' }));

        if (prev.status !== state.status) {
          if (state.status === 'playing') await startGame(state);
          else if (state.status === 'ended') await endGame(state);
          else if (state.status === 'lobby') sock._fire('room-restarted', state);
        } else if (state.status === 'lobby' || left.length || ids.size !== prev.ids.size) {
          sock._fire('room-state', state);
        }

        if (state.status === 'playing') {
          Object.values(state.players).forEach(p => {
            if (p.submitted && !prev.submitted.has(p.id)) {
              sock._fire('player-submitted', {
                playerId: p.id, name: p.name, score: p.score, passed: p.passed,
                failedCritical: p.failedCritical, submitTime: p.submitTime, answers: {}
              });
            }
          });
        }
        prev = { status: state.status, ids, submitted };
      } catch (e) {
        console.warn('refresh lỗi:', e.message || e);
      } finally {
        refreshing = false;
        if (refreshAgain) { refreshAgain = false; refresh(); }
      }
    }

    async function startGame(state) {
      const questions = await rpc('gp_get_questions', { p_code: room });
      answered = {};
      sock._fire('game-started', { room: state, questions });
    }

    async function endGame(state) {
      const res = await rpc('gp_get_results', { p_code: room });
      if (!res) return;
      const rankings = res.rankings.map(r => Object.assign({}, r));
      sock._fire('game-ended', { rankings, room: state, questions: res.questions });
    }

    function subscribe() {
      channel = sb.channel('room:' + room, { config: { broadcast: { self: false }, presence: { key: sock.id } } });
      const bc = (event, ev) => channel.on('broadcast', { event }, ({ payload }) => sock._fire(ev, payload));
      bc('cursor', 'player-cursor');
      bc('progress', 'player-progress-updated');
      bc('navigate', 'player-navigated');
      bc('reaction', 'player-reaction');
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'code=eq.' + room }, refresh);
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: 'room_code=eq.' + room }, refresh);
      channel.on('presence', { event: 'leave' }, ({ key }) => {
        if (!key || key === sock.id) return;
        // chờ vài giây rồi mới coi là rời phòng (tránh mất kết nối thoáng qua)
        setTimeout(() => {
          const still = channel && channel.presenceState()[key];
          if (!still || !still.length) rpc('gp_leave', { p_pid: key, p_code: room }).then(refresh).catch(() => {});
        }, 4000);
      });
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') channel.track({ at: Date.now() });
        if (status === 'CHANNEL_ERROR') sock._fire('connect_error', new Error('realtime'));
      });
      timer = setInterval(refresh, FALLBACK_REFRESH_MS);
    }

    function stop() {
      clearInterval(timer);
      timer = null;
      if (channel) { sb.removeChannel(channel); channel = null; }
      room = null; prev = null;
    }

    function joined(res) {
      room = res.roomCode;
      me = res.player;
      prev = null;
      subscribe();
      refresh();
    }

    const sendBc = (event, payload) => channel && channel.send({ type: 'broadcast', event, payload });
    const who = () => ({ playerId: sock.id, name: me.name, avatar: me.avatar, color: me.color });

    sock.emit = function (ev, data, cb) {
      data = data || {};
      const done = (res) => { if (cb) cb(res); };
      const fail = (e) => {
        console.error(ev, e);
        sock._fire('connect_error', e);
        done({ success: false, message: 'Không kết nối được server!' });
      };
      switch (ev) {
        case 'create-room':
          rpc('gp_create_room', { p_pid: sock.id, p_name: data.name, p_avatar: data.avatar, p_mode: data.mode, p_time: data.timeLimit })
            .then(res => { if (res.success) joined(res); done(res); }).catch(fail);
          break;
        case 'join-room':
          rpc('gp_join_room', { p_pid: sock.id, p_code: data.roomCode, p_name: data.name, p_avatar: data.avatar })
            .then(res => { if (res.success) joined(res); done(res); }).catch(fail);
          break;
        case 'start-game':
          rpc('gp_start_game', { p_pid: sock.id, p_code: room }).then(refresh).catch(fail);
          break;
        case 'select-answer':
          answered[data.qIndex] = data.optionIndex;
          rpc('gp_select_answer', { p_pid: sock.id, p_code: room, p_q: data.qIndex, p_opt: data.optionIndex }).catch(fail);
          sendBc('progress', Object.assign(who(), {
            qIndex: data.qIndex, totalAnswered: Object.keys(answered).length,
            answeredList: Object.keys(answered).map(Number)
          }));
          break;
        case 'navigate-question':
          sendBc('navigate', { playerId: sock.id, qIndex: data.qIndex });
          break;
        case 'cursor-move':
          if (me) sendBc('cursor', Object.assign(who(), { x: data.xPercent, y: data.yPercent, qIndex: data.qIndex }));
          break;
        case 'send-reaction': {
          const payload = Object.assign(who(), { emoji: data.emoji });
          sendBc('reaction', payload);
          sock._fire('player-reaction', payload);
          break;
        }
        case 'submit-exam':
          rpc('gp_submit', { p_pid: sock.id, p_code: room }).then(refresh).catch(fail);
          break;
        case 'restart-game':
          rpc('gp_restart', { p_pid: sock.id, p_code: room }).then(refresh).catch(fail);
          break;
        case 'leave-room':
          rpc('gp_leave', { p_pid: sock.id, p_code: room }).then(stop).catch(() => {});
          break;
        default:
          break;
      }
    };

    window.addEventListener('pagehide', () => {
      if (!room) return;
      try {
        fetch(URL + '/rest/v1/rpc/gp_leave', {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY },
          body: JSON.stringify({ p_pid: sock.id, p_code: room })
        });
      } catch (e) { /* ignore */ }
    });

    setTimeout(() => { sock.connected = true; sock._fire('connect'); }, 0);
    return sock;
  }

  window.io = createSocket;
})();
