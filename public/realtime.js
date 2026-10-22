// Shim tương thích API socket.io (emit/on) chạy trên HTTP: POST /api/emit + GET /api/poll.
// Dùng cho Vercel (serverless, không giữ được kết nối WebSocket).
(function () {
  const API = (window.GAME_API_URL || '').replace(/\/$/, '');
  const POLL_LOBBY_MS = 1000;
  const POLL_GAME_MS = 700;
  const POLL_HIDDEN_MS = 2500; // tab ở nền: poll thưa để đỡ tải
  const CURSOR_MS = 500;

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
    const handlers = {};
    const sock = {
      id: getPlayerId(),
      connected: false,
      _room: null,
      _since: 0,
      _timer: null,
      _fails: 0,
      _inGame: false,
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
      _fire(ev, data) { (handlers[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(ev, e); } }); },

      emit(ev, data, cb) {
        // Chuột: gộp lại, tối đa ~2 lần/giây để không quá tải serverless
        if (ev === 'cursor-move') {
          sock._pendingCursor = data;
          if (!sock._cursorTimer) {
            sock._cursorTimer = setTimeout(() => {
              sock._cursorTimer = null;
              const d = sock._pendingCursor;
              sock._pendingCursor = null;
              if (d && sock._room) sock._send('cursor-move', d);
            }, CURSOR_MS);
          }
          return;
        }
        sock._send(ev, data, cb);
      },

      _send(ev, data, cb) {
        const body = { event: ev, data: data || {}, playerId: sock.id, roomCode: sock._room };
        fetch(API + '/api/emit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(r => r.json())
          .then(res => {
            if ((ev === 'create-room' || ev === 'join-room' || ev === 'spectate-room') && res && res.success) {
              sock._room = res.roomCode;
              sock._since = res.seq || 0;
              sock._startPolling();
            }
            if (ev === 'restart-game') sock._inGame = false;
            if (cb) cb(res);
            // Vào lại giữa trận: server trả sẵn đề + trạng thái để khôi phục
            if ((ev === 'join-room' || ev === 'spectate-room') && res && res.success && res.resume) {
              sock._inGame = true;
              setTimeout(() => {
                if (ev === 'spectate-room') sock._fire('room-state', res.room);
                sock._fire('game-started', res.resume);
              }, 0);
            } else if (ev === 'spectate-room' && res && res.success) {
              setTimeout(() => sock._fire('room-state', res.room), 0);
            }
          })
          .catch(() => {
            sock._fire('connect_error', new Error('network'));
            if (cb) cb({ success: false, message: 'Không kết nối được server!' });
          });
      },

      _startPolling() {
        if (sock._timer) return;
        const tick = async () => {
          try {
            const url = `${API}/api/poll?room=${sock._room}&pid=${encodeURIComponent(sock.id)}&since=${sock._since}`;
            const res = await fetch(url, { cache: 'no-store' });
            if (res.status === 404) throw new Error('room-gone');
            const out = await res.json();
            if (sock._down) { sock._down = false; sock._fire('net-up'); }
            sock._fails = 0;
            sock._since = out.seq;
            out.events.forEach(e => {
              if (e.ev === 'game-started') sock._inGame = true;
              if (e.ev === 'game-ended' || e.ev === 'room-restarted') sock._inGame = false;
              sock._fire(e.ev, e.data);
            });
          } catch (e) {
            if (++sock._fails >= 2 && !sock._down) { sock._down = true; sock._fire('net-down'); }
            if (sock._fails >= 5) { sock._fire('disconnect'); sock._fails = 0; }
          }
          const base = sock._inGame ? POLL_GAME_MS : POLL_LOBBY_MS;
          sock._timer = setTimeout(tick, document.hidden ? Math.max(base, POLL_HIDDEN_MS) : base);
        };
        sock._timer = setTimeout(tick, 0);
      }
    };

    // Chỉ báo rời phòng khi người chơi chủ động rời; tải lại/đóng tab để server dọn sau ít giây (cho phép vào lại)
    window.addEventListener('pagehide', () => {
      if (!sock._room || !window.GPLX_LEAVING) return;
      try {
        navigator.sendBeacon(API + '/api/emit', new Blob([JSON.stringify({
          event: 'leave-room', data: {}, playerId: sock.id, roomCode: sock._room
        })], { type: 'application/json' }));
      } catch (e) { /* ignore */ }
    });

    setTimeout(() => { sock.connected = true; sock._fire('connect'); }, 0);
    return sock;
  }

  window.io = createSocket;
})();
