/**
 * Trải nghiệm nhiều người chơi: toast sự kiện, sẵn sàng + đếm ngược, chat nhanh, đường đua xếp hạng sống,
 * chế độ Đồng bộ (cả phòng cùng 1 câu, tính điểm theo tốc độ) và tự vào lại phòng khi tải lại trang.
 * Tất cả chạy phía client qua kênh relay 'fx' nên dùng được cho cả Supabase lẫn Redis/polling.
 * Dữ liệu cá nhân (phiên, ván đang chơi) chỉ lưu trong localStorage.
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const Live = (() => {
  const $ = id => document.getElementById(id);
  const SESSION_KEY = 'gplx_session';
  const GAME_KEY = 'gplx_game_state';
  const SESSION_TTL = 6 * 3600 * 1000;
  const MEDALS = ['🥇', '🥈', '🥉'];
  const MODE_LABELS = {
    standard: '🎯 Chuẩn thi sát hạch B/B1',
    wrong: '🔁 Luyện lại câu từng sai',
    critical: '⚠️ Thử thách điểm liệt',
    signs: '🖼️ Sa hình & Biển báo',
    live: '⚡ Đua tốc độ đồng bộ',
    survival: '💀 Sinh tồn: sai 1 câu là bị loại',
    team: '🤝 Đồng đội: 2 đội đua điểm'
  };
  const MODE_RULES = {
    standard: '30 câu, mỗi người tự làm. Cần từ 27 câu đúng trở lên và không sai câu điểm liệt để đạt.',
    live: 'Cả phòng cùng làm 1 câu, 15 câu × 15 giây. Đúng càng nhanh càng nhiều điểm, đúng liên tiếp được thưởng thêm.',
    survival: 'Cùng 1 câu, 12 giây mỗi câu. Sai hoặc hết giờ là bị loại, người cuối cùng còn sống sẽ thắng.',
    team: 'Tự chia 2 đội 🔵 🔴. Điểm của từng người cộng dồn cho đội, đội nhiều điểm hơn sẽ thắng.',
    critical: '30 câu chọn từ các câu điểm liệt. Sai một câu là rớt.',
    signs: '30 câu sa hình và biển báo (chương 5, 6).'
  };
  const SYNC_MODES = ['live', 'survival', 'team'];
  const TEAMS = [
    { name: 'Đội Xanh', dot: '🔵', color: '#3b82f6' },
    { name: 'Đội Đỏ', dot: '🔴', color: '#ef4444' }
  ];

  const ready = {};
  const chatLog = [];
  const reachedAt = {};
  const lastKey = {};
  let candidate = null;
  let hbTimer = null;
  let saveTimer = null;
  let cdTimer = null;
  let lastChatAt = 0;
  let prevRank = {};
  let leaderId = null;
  let gameStartAt = 0;
  let lastRankToast = 0;
  let lastPokeAt = 0;
  const lastSeen = {};
  const firstSeen = {};
  const rematch = {};
  const fxGate = {};

  const sync = {
    teams: {},
    active: false, total: 15, T: 15, R: 5, epoch: 0, q: -1, phase: '', timer: null,
    locked: false, msg: '', lastSec: -1,
    mine: { total: 0, gain: 0, streak: 0, done: -1, out: -1 },
    pts: {}, ans: {}
  };

  // Mỗi người chơi (mỗi tab) có khóa lưu ván riêng để các tab cùng trình duyệt không khôi phục nhầm của nhau
  const gameKey = () => `${GAME_KEY}:${state.myId}`;

  function clearGame() {
    try { localStorage.removeItem(gameKey()); } catch (e) { /* ignore */ }
  }

  // ---------- Cảm giác trên điện thoại: rung, giữ màn hình sáng, nháy tiêu đề tab ----------
  let wakeLock = null;
  let wantAwake = false;
  const baseTitle = document.title;

  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* ignore */ }
  }

  async function keepAwake(on) {
    wantAwake = on;
    try {
      if (on) {
        if (!wakeLock && navigator.wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
      } else if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* trình duyệt không hỗ trợ hoặc bị từ chối */ }
  }

  // Khi đang ở tab khác: đổi tiêu đề để người chơi biết có việc (sắp vào trận, bị chọc, có chat)
  function attention(msg) {
    if (!document.hidden) return;
    document.title = `${msg} — ${baseTitle}`;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      document.title = baseTitle;
      if (wantAwake) keepAwake(true);
    }
  });

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  // ---------- Toast & trạng thái mạng ----------
  function toast(msg, kind = 'info', ms = 3200) {
    const stack = $('toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = msg;
    stack.appendChild(el);
    while (stack.children.length > 4) stack.firstChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  function netDown() {
    const b = $('netBanner');
    if (b) b.style.display = 'block';
  }
  function netUp() {
    const b = $('netBanner');
    if (b && b.style.display !== 'none') {
      b.style.display = 'none';
      toast('✅ Đã kết nối lại', 'ok');
    }
  }
  window.addEventListener('offline', netDown);
  window.addEventListener('online', netUp);

  // ---------- Phiên & tự vào lại phòng ----------
  function prepareSession() {
    candidate = null;
    const rec = readJSON(SESSION_KEY);
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (!rec || !rec.pid || !rec.room || urlRoom) return;
    if (Date.now() - rec.ts > SESSION_TTL) { clearSession(); return; }
    let mine = null;
    try { mine = sessionStorage.getItem('gplx_pid'); } catch (e) { /* ignore */ }
    if (mine) {
      if (mine === rec.pid) candidate = rec; // tải lại cùng tab
      return;
    }
    // Tab mới: chỉ nhận lại phiên khi không có tab nào khác đang giữ (nhịp tim cũ)
    if (Date.now() - (rec.hb || 0) > 6000) {
      try { sessionStorage.setItem('gplx_pid', rec.pid); } catch (e) { return; }
      candidate = rec;
    }
  }

  function beginSession(room) {
    const now = Date.now();
    writeJSON(SESSION_KEY, { pid: state.myId, room, ts: now, hb: now });
    clearInterval(hbTimer);
    let n = 0;
    hbTimer = setInterval(() => {
      const rec = readJSON(SESSION_KEY);
      if (rec && rec.pid === state.myId) { rec.hb = Date.now(); writeJSON(SESSION_KEY, rec); }
      // Nhịp tim gửi cho cả phòng để hiện trạng thái kết nối của từng người
      if (++n % 2 === 1) {
        send('hb', {});
        if (screenWaiting.classList.contains('active')) renderWaitingList();
        else if (screenGame.classList.contains('active')) updateRace();
      }
    }, 2000);
  }

  function clearSession() {
    clearInterval(hbTimer);
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    clearGame();
  }

  // Rời phòng chủ động: báo server rồi tải lại (shim chỉ gửi leave-room khi cờ này bật)
  function leaveAndReload() {
    window.GPLX_LEAVING = true;
    clearSession();
    window.location.reload();
  }

  function tryRejoin() {
    if (!candidate) return false;
    const rec = candidate;
    candidate = null;
    state.rejoining = true;
    const { name, avatar } = getMyProfile();
    state.socket.emit('join-room', { roomCode: rec.room, name, avatar }, res => {
      if (res && res.success) {
        state.roomCode = res.roomCode;
        state.isHost = !!(res.player && res.player.isHost);
        $('displayRoomCode').textContent = res.roomCode;
        beginSession(res.roomCode);
        showScreen(screenWaiting);
        toast(`🔄 Đã vào lại phòng ${res.roomCode}`, 'ok');
      } else {
        state.rejoining = false;
        clearSession();
      }
    });
    return true;
  }

  function saveGame() {
    if (state.isSolo || !state.roomCode || !state.startedAt) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      writeJSON(gameKey(), {
        room: state.roomCode, startedAt: state.startedAt,
        answers: state.myAnswers, flags: [...state.flaggedQuestions], cur: state.currentQIndex,
        submitted: state.hasSubmitted, mine: sync.mine, teams: sync.teams, changes: state.behavior.answerChangesCount
      });
    }, 250);
  }

  function restoreGame() {
    if (state.isSolo) return false;
    const g = readJSON(gameKey());
    if (!g || g.room !== state.roomCode || g.startedAt !== state.startedAt) return false;
    state.myAnswers = g.answers || {};
    state.flaggedQuestions = new Set(g.flags || []);
    state.currentQIndex = g.cur || 0;
    state.hasSubmitted = !!g.submitted;
    state.behavior.answerChangesCount = g.changes || 0;
    if (g.mine) sync.mine = g.mine;
    if (g.teams) sync.teams = g.teams;
    if (state.socket && state.socket.seedAnswers) state.socket.seedAnswers(state.myAnswers);
    return true;
  }

  // ---------- Sẵn sàng, chat, đếm ngược ----------
  function send(t, data) {
    if (state.isSolo || !state.socket || !state.roomCode) return;
    state.socket.emit('fx', Object.assign({ t }, data));
  }

  function isReady(p) { return !!(p.isHost || ready[p.id]); }

  function toggleReady() {
    ready[state.myId] = !ready[state.myId];
    send('ready', { v: ready[state.myId] });
    SoundEngine.playSelect();
    renderWaitingList();
  }

  function readyCounts(players) {
    const list = Object.values(players);
    return { ok: list.filter(isReady).length, all: list.length };
  }

  function modeLabel(mode) { return MODE_LABELS[mode] || MODE_LABELS.standard; }
  function modeRules(mode) { return MODE_RULES[mode] || ''; }

  function renderChat() {
    const box = $('waitingChatLog');
    if (!box) return;
    box.innerHTML = chatLog.map(m => `
      <div class="chat-line${m.self ? ' self' : ''}">
        <span class="chat-who" style="color:${esc(m.color)}">${esc(m.avatar)} ${esc(m.name)}</span>
        <span class="chat-txt">${esc(m.text)}</span>
      </div>`).join('');
    box.scrollTop = box.scrollHeight;
  }

  function showChat(p, text, self) {
    chatLog.push({ name: p.name, avatar: p.avatar, color: p.color || '#3b82f6', text, self: !!self });
    if (chatLog.length > 30) chatLog.shift();
    if (screenWaiting.classList.contains('active')) renderChat();
    else toast(`${p.avatar} ${p.name}: ${text}`, self ? 'chat-self' : 'chat', 3800);
    if (!self) {
      SoundEngine.playChat();
      attention(`💬 ${p.name}`);
    }
  }

  function sendChat(text) {
    text = String(text || '').trim().slice(0, 60);
    if (!text || state.isSolo) return;
    const now = Date.now();
    if (now - lastChatAt < 800) return;
    lastChatAt = now;
    const me = state.players[state.myId] || getMyProfile();
    send('chat', { text });
    showChat({ name: me.name, avatar: me.avatar, color: me.color }, text, true);
  }

  function startCountdown(isHost, secs = 3) {
    const ov = $('countdownOverlay');
    const num = $('countdownNum');
    if (!ov || !num) return;
    clearTimeout(cdTimer);
    ov.classList.add('show');
    if (!isHost) { attention('🏁 Sắp vào trận!'); buzz(80); }
    let n = secs;
    const step = () => {
      if (n > 0) {
        num.textContent = n;
        num.classList.remove('pop');
        void num.offsetWidth;
        num.classList.add('pop');
        SoundEngine.playCountdown(n);
        n--;
        cdTimer = setTimeout(step, 1000);
      } else {
        num.textContent = 'GO!';
        num.classList.remove('pop');
        void num.offsetWidth;
        num.classList.add('pop');
        SoundEngine.playGo();
        if (isHost) state.socket.emit('start-game');
        cdTimer = setTimeout(hideCountdown, 6000);
      }
    };
    step();
  }

  function hideCountdown() {
    clearTimeout(cdTimer);
    const ov = $('countdownOverlay');
    if (ov) ov.classList.remove('show');
    const btn = $('btnStartGame');
    if (btn) btn.disabled = false;
  }

  function hostStart() {
    if (!state.isHost) return;
    $('btnStartGame').disabled = true;
    send('countdown', { secs: 3 });
    startCountdown(true, 3);
  }

  // ---------- Sự kiện phòng ----------
  function onRoomState(oldPlayers, newPlayers, room) {
    const oldIds = Object.keys(oldPlayers || {});
    if (oldIds.length) {
      Object.values(newPlayers).forEach(p => {
        if (!oldPlayers[p.id] && p.id !== state.myId) {
          SoundEngine.playChat();
          if (ready[state.myId]) send('ready', { v: true }); // báo trạng thái cho người mới
        }
      });
    }
    if (state.rejoining) {
      state.rejoining = false;
      if (room.status === 'ended') {
        clearSession();
        toast('Phòng đã kết thúc ván đấu', 'info');
        showScreen(screenLobby);
        resetLobbyButtons();
      }
    }
  }

  function onFx(m) {
    if (!m || m.from === state.myId) return;
    const now = Date.now();
    lastSeen[m.from] = now;
    // Supabase Broadcast không giới hạn được ở server: bỏ qua chat/chọc dồn dập từ cùng một người
    if (m.t === 'chat' || m.t === 'poke' || m.t === 'rematch') {
      const k = `${m.from}:${m.t}`;
      if (now - (fxGate[k] || 0) < 600) return;
      fxGate[k] = now;
    }
    const p = state.players[m.from];
    switch (m.t) {
      case 'ready':
        ready[m.from] = !!m.v;
        if (screenWaiting.classList.contains('active')) renderWaitingList();
        break;
      case 'chat':
        if (p) showChat(p, String(m.text || '').slice(0, 60), false);
        break;
      case 'countdown':
        if (screenWaiting.classList.contains('active')) startCountdown(false, Math.min(5, Number(m.secs) || 3));
        break;
      case 'pts':
        sync.pts[m.from] = {
          total: Number(m.total) || 0, gain: Number(m.gain) || 0, streak: Number(m.streak) || 0,
          out: Number.isInteger(m.out) ? m.out : -1
        };
        if (isSurvival() && sync.pts[m.from].out >= 0 && p) toast(`💀 ${p.name} bị loại ở câu ${sync.pts[m.from].out + 1}!`, 'down');
        updateRace();
        break;
      case 'hb':
        break;
      case 'poke':
        if (m.to === state.myId && p) {
          toast(`👉 ${p.name} chọc bạn! Tập trung nào!`, 'warn');
          SoundEngine.playCriticalAlert();
          buzz([120, 60, 120]);
          attention(`👉 ${p.name} chọc bạn`);
          const pane = document.querySelector('.question-pane');
          if (pane) {
            pane.classList.remove('shake-screen');
            void pane.offsetWidth;
            pane.classList.add('shake-screen');
          }
        }
        break;
      case 'rematch':
        rematch[m.from] = true;
        if (p) toast(`🔁 ${p.name} muốn đấu lại`, 'ok');
        updateRematchUi();
        break;
      default:
        break;
    }
  }

  function timeToast(sec) {
    if (isLive() || state.isSolo) return;
    if (sec === 300) toast('⏳ Còn 5 phút!', 'warn');
    else if (sec === 60) toast('⏳ Còn 1 phút — kiểm tra lại các câu cắm cờ!', 'warn');
    else if (sec === 10) toast('🚨 Còn 10 giây!', 'danger');
  }

  function onPeerProgress(data) {
    if (isLive() || state.isReviewMode) return;
    if (data.totalAnswered === 30) toast(`🏁 ${data.name || 'Đối thủ'} đã làm đủ 30 câu!`, 'warn');
  }

  function onPeerSubmitted(data) {
    if (isLive()) return;
    toast(`📝 ${data.name || 'Đối thủ'} vừa nộp bài (${data.score ?? 0}/30)`, 'info');
  }

  function onPeerLeft(name) {
    toast(`👋 ${name || 'Một người chơi'} đã rời phòng`, 'leave');
  }

  function onRestart() {
    Object.keys(ready).forEach(k => delete ready[k]);
    Object.keys(rematch).forEach(k => delete rematch[k]);
    updateRematchUi();
    keepAwake(false);
    hideCountdown();
    stopSync();
    document.body.classList.remove('live-game', 'live-mode');
    clearGame();
  }

  // ---------- Đường đua ----------
  function countOf(p) {
    if (p.id === state.myId) return Object.keys(state.myAnswers).length;
    return p.totalAnswered ?? p.answeredList?.length ?? Object.keys(p.answers || {}).length;
  }

  function ptsOf(id) {
    return id === state.myId ? sync.mine.total : (sync.pts[id]?.total || 0);
  }

  function outOf(id) {
    return id === state.myId ? sync.mine.out : (sync.pts[id]?.out ?? -1);
  }

  // Trạng thái kết nối: dựa vào nhịp tim 'hb' và mọi tin 'fx' nhận được
  function dot(id) {
    if (id === state.myId) return '🟢';
    const now = Date.now();
    if (firstSeen[id] === undefined) firstSeen[id] = now;
    const age = now - (lastSeen[id] ?? firstSeen[id]);
    if (age < 12000) return '🟢';
    return age < 25000 ? '🟡' : '🔴';
  }

  function teamOf(id) { return sync.teams[id] ?? 0; }

  function assignTeams() {
    sync.teams = {};
    Object.keys(state.players).sort().forEach((id, i) => { sync.teams[id] = i % 2; });
  }

  // Huy hiệu đội xem trước ở phòng chờ (chia theo thứ tự id, cố định giữa các máy)
  function teamBadge(id) {
    if (!isTeam()) return '';
    const idx = Object.keys(state.players).sort().indexOf(id);
    return TEAMS[idx % 2].dot;
  }

  function teamTotals() {
    const t = [0, 0];
    Object.keys(sync.teams).forEach(id => { t[sync.teams[id]] += ptsOf(id); });
    return t;
  }

  function poke(pid) {
    if (pid === state.myId || state.isSolo) return;
    const now = Date.now();
    if (now - lastPokeAt < 4000) { toast('Đợi vài giây rồi hãy chọc tiếp nhé 😅', 'info', 1500); return; }
    lastPokeAt = now;
    send('poke', { to: pid });
    const p = state.players[pid];
    toast(`👉 Bạn đã chọc ${p ? p.name : 'đối thủ'}!`, 'info', 1800);
    SoundEngine.playChat();
  }

  function updateRace() {
    const el = $('raceTrack');
    if (!el) return;
    const players = Object.values(state.players);
    const show = !state.isSolo && players.length > 1 && screenGame.classList.contains('active') && !state.isReviewMode;
    el.style.display = show ? 'flex' : 'none';
    // Trên điện thoại, đường đua thay cho thanh đối thủ (trừ khi đã nộp bài và muốn theo dõi người khác)
    document.body.classList.toggle('has-race', show && !state.hasSubmitted);
    if (!show) return;

    const live = isLive();
    const now = Date.now();
    const rows = players.map((p, i) => {
      let key; let pct; let text;
      if (live) {
        const pts = ptsOf(p.id);
        const out = isSurvival() ? outOf(p.id) : -1;
        key = (isSurvival() ? (out < 0 ? 1e7 : (out + 1) * 1e5) : 0) + pts;
        pct = Math.min(100, (pts / (sync.total * 900)) * 100);
        const g = sync.phase === 'reveal' ? (p.id === state.myId ? sync.mine.gain : (sync.pts[p.id]?.gain || 0)) : 0;
        text = out >= 0 ? `💀 câu ${out + 1}` : `${pts} đ${g > 0 ? ` (+${g})` : ''}`;
      } else if (p.submitted) {
        key = 1000 + (p.score || 0);
        pct = 100;
        text = `${p.score ?? 0}/30 ✓`;
      } else {
        const cnt = countOf(p);
        key = cnt;
        pct = (cnt / 30) * 100;
        text = `${cnt}/30`;
      }
      if (lastKey[p.id] !== key) { lastKey[p.id] = key; reachedAt[p.id] = now; }
      return { p, key, pct, text, i };
    });
    rows.sort((a, b) => b.key - a.key || reachedAt[a.p.id] - reachedAt[b.p.id] || a.i - b.i);

    const ids = new Set(rows.map(r => r.p.id));
    el.querySelectorAll('.race-lane').forEach(l => { if (!ids.has(l.dataset.pid)) l.remove(); });
    const ranks = {};
    rows.forEach((r, idx) => {
      ranks[r.p.id] = idx;
      let lane = el.querySelector(`.race-lane[data-pid="${CSS.escape(r.p.id)}"]`);
      if (!lane) {
        lane = document.createElement('div');
        lane.className = 'race-lane';
        lane.dataset.pid = r.p.id;
        lane.innerHTML = '<span class="rl-rank"></span><span class="rl-name"></span>'
          + '<div class="rl-road"><div class="rl-fill"></div><span class="rl-car"></span><span class="rl-flag">🏁</span></div>'
          + '<span class="rl-score"></span>';
        lane.addEventListener('click', () => poke(lane.dataset.pid));
        el.appendChild(lane);
      }
      const out = live && isSurvival() ? outOf(r.p.id) : -1;
      lane.style.order = idx + 1;
      lane.classList.toggle('me', r.p.id === state.myId);
      lane.classList.toggle('out', out >= 0);
      lane.title = r.p.id === state.myId ? '' : `Bấm để chọc ${r.p.name} 👉`;
      lane.querySelector('.rl-rank').textContent = MEDALS[idx] || String(idx + 1);
      const teamTag = live && isTeam() ? `${TEAMS[teamOf(r.p.id)].dot} ` : '';
      lane.querySelector('.rl-name').textContent = `${dot(r.p.id)} ${teamTag}${r.p.name}${r.p.id === state.myId ? ' (Bạn)' : ''}`;
      const fill = lane.querySelector('.rl-fill');
      fill.style.width = `${r.pct}%`;
      fill.style.background = live && isTeam() ? TEAMS[teamOf(r.p.id)].color : r.p.color;
      const car = lane.querySelector('.rl-car');
      car.textContent = out >= 0 ? '💀' : r.p.avatar;
      car.style.textShadow = `0 0 7px ${r.p.color}, 0 0 2px ${r.p.color}`;
      car.style.left = `calc((100% - 26px) * ${r.pct / 100})`;
      lane.querySelector('.rl-score').textContent = r.text;
    });

    // Bảng điểm đội
    let teamRow = el.querySelector('.team-row');
    if (live && isTeam()) {
      if (!teamRow) {
        teamRow = document.createElement('div');
        teamRow.className = 'team-row';
        teamRow.innerHTML = '<span class="tr-a"></span><div class="tr-bar"><div class="tr-fill"></div></div><span class="tr-b"></span>';
        el.appendChild(teamRow);
      }
      const [ta, tb] = teamTotals();
      teamRow.style.order = 0;
      teamRow.querySelector('.tr-a').textContent = `${TEAMS[0].dot} ${TEAMS[0].name} ${ta}`;
      teamRow.querySelector('.tr-b').textContent = `${tb} ${TEAMS[1].name} ${TEAMS[1].dot}`;
      teamRow.querySelector('.tr-fill').style.width = `${ta + tb > 0 ? (ta / (ta + tb)) * 100 : 50}%`;
    } else if (teamRow) {
      teamRow.remove();
    }

    announceRank(rows, ranks, now);
  }

  function announceRank(rows, ranks, now) {
    const me = state.myId;
    const warm = now - gameStartAt > 2500;
    if (warm && prevRank[me] !== undefined && now - lastRankToast > 2500) {
      const was = prevRank[me];
      const cur = ranks[me];
      if (cur < was) {
        const passed = rows.filter(r => r.p.id !== me && prevRank[r.p.id] !== undefined && prevRank[r.p.id] < was && ranks[r.p.id] > cur).map(r => r.p.name);
        toast(`🚀 Bạn vượt ${passed.join(', ') || 'đối thủ'} lên hạng ${cur + 1}!`, 'up');
        SoundEngine.playOvertake();
        lastRankToast = now;
      } else if (cur > was) {
        const by = rows.filter(r => r.p.id !== me && prevRank[r.p.id] !== undefined && prevRank[r.p.id] > was && ranks[r.p.id] < cur).map(r => r.p.name);
        toast(`😱 ${by.join(', ') || 'Đối thủ'} vượt bạn! Bạn tụt xuống hạng ${cur + 1}`, 'down');
        lastRankToast = now;
      }
    }
    const lead = rows[0];
    if (lead && lead.key > 0 && lead.p.id !== leaderId) {
      if (warm && now - lastRankToast > 1200) {
        toast(lead.p.id === me ? '👑 Bạn đang dẫn đầu!' : `👑 ${lead.p.name} vươn lên dẫn đầu`, 'lead');
        lastRankToast = now;
      }
      leaderId = lead.p.id;
    }
    prevRank = ranks;
  }

  // ---------- Chế độ Đồng bộ / Sinh tồn / Đồng đội ----------
  function isSyncMode(mode) { return SYNC_MODES.includes(mode); }
  function isLive() { return isSyncMode(state.gameMode) && !state.isSolo; }
  function isSurvival() { return state.gameMode === 'survival'; }
  function isTeam() { return state.gameMode === 'team'; }
  function questionCount() { return document.body.classList.contains('live-game') ? sync.total : 30; }
  function isEliminated() { return isSurvival() && sync.mine.out >= 0; }

  function onExamStart(resumed) {
    clearInterval(sync.timer);
    sync.active = false;
    sync.pts = {};
    sync.ans = {};
    sync.q = -1;
    sync.phase = '';
    sync.locked = false;
    prevRank = {};
    leaderId = null;
    gameStartAt = Date.now();
    lastRankToast = 0;
    Object.keys(lastKey).forEach(k => delete lastKey[k]);
    Object.keys(rematch).forEach(k => delete rematch[k]);
    updateRematchUi();
    document.body.classList.toggle('live-game', isLive());
    document.body.classList.toggle('live-mode', isLive());
    keepAwake(true);
    const bar = $('liveBar');
    if (bar) bar.style.display = isLive() ? 'block' : 'none';
    if (!isLive()) return false;
    sync.total = isSurvival() ? 20 : 15;
    sync.T = isSurvival() ? 12 : 15;
    if (!resumed) {
      sync.mine = { total: 0, gain: 0, streak: 0, done: -1, out: -1 };
      assignTeams();
    } else if (!Object.keys(sync.teams).length) {
      assignTeams();
    }
    if (isTeam()) {
      const t = TEAMS[teamOf(state.myId)];
      toast(`${t.dot} Bạn thuộc ${t.name}! Điểm cả đội được cộng dồn`, 'ok', 4500);
    }
    if (state.hasSubmitted) return true;
    sync.active = true;
    sync.epoch = resumed ? state.startedAt : Date.now();
    tick();
    sync.timer = setInterval(tick, 100);
    return true;
  }

  // Sinh tồn: kết thúc sớm khi chỉ còn tối đa 1 người sống
  function survivalOver() {
    if (!isSurvival()) return false;
    const list = Object.values(state.players);
    if (list.length < 2) return false;
    return list.filter(p => outOf(p.id) < 0).length <= 1;
  }

  // Khán giả: chỉ dựng giao diện xem, không chạy vòng điều khiển câu hỏi
  function onSpectatorStart() {
    clearInterval(sync.timer);
    sync.active = false;
    sync.pts = {};
    prevRank = {};
    leaderId = null;
    gameStartAt = Date.now();
    Object.keys(lastKey).forEach(k => delete lastKey[k]);
    document.body.classList.toggle('live-game', isLive());
    document.body.classList.remove('live-mode');
    document.body.classList.add('spectator');
    keepAwake(true);
    if (isLive()) {
      sync.total = isSurvival() ? 20 : 15;
      sync.T = isSurvival() ? 12 : 15;
      assignTeams();
    }
    const bar = $('liveBar');
    if (bar) bar.style.display = 'none';
  }

  function tick() {
    if (!sync.active) return;
    const cycle = sync.T + sync.R;
    const el = (Date.now() - sync.epoch) / 1000;
    const q = Math.floor(el / cycle);
    // Tab bị trình duyệt làm chậm có thể bỏ lỡ pha công bố: tính bù các câu đã qua
    for (let k = sync.mine.done + 1; k < Math.min(q, sync.total); k++) onReveal(k);
    if (q >= sync.total || (q > sync.q && q > 0 && survivalOver())) { finishSync(); return; }
    const within = el - q * cycle;
    const phase = within < sync.T ? 'answer' : 'reveal';
    const left = phase === 'answer' ? sync.T - within : cycle - within;

    if (q !== sync.q || phase !== sync.phase) {
      sync.q = q;
      sync.phase = phase;
      state.liveQ = q;
      if (phase === 'answer') {
        sync.locked = state.myAnswers[q] !== undefined || isEliminated();
        sync.msg = '';
        SoundEngine.playNav();
      } else {
        onReveal(q);
      }
      renderQuestion(q);
      updatePaletteGrid();
      updateRace();
      saveGame();
    }
    paintBar(q, phase, left);
  }

  function onReveal(q) {
    const question = state.exam30[q];
    const mine = sync.mine;
    const picked = state.myAnswers[q];
    const wasOut = isEliminated();
    if (q > mine.done) {
      let a = sync.ans[q];
      if (!a && picked !== undefined) a = { ok: picked === question.correct_option, base: 600 };
      let gain = 0;
      if (a && a.ok) {
        gain = a.base + Math.min(mine.streak, 4) * 50;
        mine.streak++;
      } else {
        mine.streak = 0;
        if (isSurvival() && !wasOut) mine.out = q;
      }
      mine.total += gain;
      mine.gain = gain;
      mine.done = q;
    }
    const ok = picked !== undefined && picked === question.correct_option;
    if (wasOut) sync.msg = '💀 Bạn đã bị loại — tiếp tục theo dõi các đối thủ';
    else if (picked === undefined) sync.msg = isSurvival() ? '⏰ Hết giờ — bạn bị loại! 💀' : '⏰ Hết giờ — +0 điểm';
    else if (ok) sync.msg = `✅ Chính xác! +${mine.gain} điểm${mine.streak > 1 ? ` · 🔥 chuỗi ${mine.streak}` : ''}`;
    else sync.msg = isSurvival() ? '❌ Sai rồi — bạn bị loại! 💀' : '❌ Chưa đúng — +0 điểm';
    send('pts', { q, total: mine.total, gain: mine.gain, streak: mine.streak, out: mine.out });
    if (ok) {
      spawnFloatingEmoji(`+${mine.gain}${mine.streak >= 3 ? ' 🔥' : ''}`, 0.5, 0.3);
      buzz(40);
    } else if (!wasOut) {
      buzz(isSurvival() ? [250, 80, 250] : [120, 60, 120]);
    }
    if (ok) SoundEngine.playVictory();
    else if (!wasOut && (picked !== undefined || isSurvival()) && (question.is_critical || isSurvival())) {
      SoundEngine.playCriticalAlert();
      const pane = document.querySelector('.question-pane');
      if (pane) {
        pane.classList.remove('shake-screen');
        void pane.offsetWidth;
        pane.classList.add('shake-screen');
      }
    }
  }

  function paintBar(q, phase, left) {
    const bar = $('liveBar');
    if (!bar) return;
    bar.classList.toggle('reveal', phase === 'reveal');
    $('liveQNum').textContent = `${isSurvival() ? '💀' : '⚡'} Câu ${q + 1}/${sync.total}`;
    const span = phase === 'answer' ? sync.T : sync.R;
    $('liveFill').style.width = `${Math.max(0, (left / span) * 100)}%`;
    const sec = Math.ceil(left);
    $('liveTime').textContent = `${sec}s`;
    $('timerText').textContent = `${sec}s`;
    bar.classList.toggle('urgent', phase === 'answer' && sec <= 5);
    if (phase === 'answer') {
      // đếm số người đã khóa đáp án câu này (người đã bị loại không tính)
      const alive = Object.values(state.players).filter(p => !(isSurvival() && outOf(p.id) >= 0));
      const done = alive.filter(p => (p.id === state.myId ? state.myAnswers[q] !== undefined : p.answers?.[q] !== undefined)).length;
      const count = alive.length > 1 ? ` · ${done}/${alive.length} người đã chọn` : '';
      $('liveMsg').textContent = isEliminated()
        ? `💀 Bạn đã bị loại — đang theo dõi${count}`
        : (sync.locked ? `🔒 Đã khóa đáp án${count}` : (isSurvival() ? `Sai 1 câu là bị loại — cẩn thận! 💀${count}` : `Chọn nhanh để được nhiều điểm hơn ⚡${count}`));
    } else {
      $('liveMsg').textContent = `${sync.msg}  ·  Câu tiếp theo sau ${sec}s`;
    }
    if (phase === 'answer' && sec <= 5 && sec !== sync.lastSec && !sync.locked) SoundEngine.playTick();
    sync.lastSec = sec;
  }

  function canAnswer(qIndex) {
    if (!sync.active) return true;
    return sync.phase === 'answer' && qIndex === sync.q && !sync.locked && !isEliminated();
  }

  function onAnswered(qIndex, optionIndex) {
    if (!sync.active) return;
    const q = state.exam30[qIndex];
    const within = (Date.now() - sync.epoch) / 1000 - qIndex * (sync.T + sync.R);
    const remaining = Math.max(0, sync.T - within);
    const ok = optionIndex === q.correct_option;
    sync.ans[qIndex] = { ok, base: ok ? Math.round(600 + 400 * remaining / sync.T) : 0 };
    sync.locked = true;
    saveGame();
  }

  function blockNav(index) {
    return sync.active && !state.isReviewMode && index !== state.liveQ;
  }

  function revealNow(index) {
    return sync.active && sync.phase === 'reveal' && index === sync.q;
  }

  function afterRender(index) {
    if (!document.body.classList.contains('live-game')) return;
    $('qBadgeNum').textContent = `Câu ${index + 1} / ${sync.total}`;
    if (state.isReviewMode) $('btnNextQ').disabled = index >= sync.total - 1;
  }

  function stopSync() {
    clearInterval(sync.timer);
    sync.active = false;
  }

  function finishSync() {
    stopSync();
    document.body.classList.remove('live-mode');
    const bar = $('liveBar');
    if (bar) bar.style.display = 'none';
    handleSubmitExam();
  }

  function sortRankings(rankings) {
    if (!isLive()) return rankings;
    rankings.forEach(r => {
      r.livePts = ptsOf(r.id);
      r.out = isSurvival() ? outOf(r.id) : -1;
      r.team = isTeam() ? teamOf(r.id) : undefined;
    });
    // Sinh tồn: người sống sót xếp trên, bị loại muộn hơn xếp trên; còn lại theo điểm
    const surv = r => (r.out < 0 ? 1e6 : r.out);
    rankings.sort((a, b) => (isSurvival() ? surv(b) - surv(a) : 0)
      || b.livePts - a.livePts || b.score - a.score || (a.submitTime || 9999) - (b.submitTime || 9999));
    return rankings;
  }

  function decorateResult(rankings) {
    keepAwake(false);
    document.body.classList.remove('live-mode');
    const bar = $('liveBar');
    if (bar) bar.style.display = 'none';
    updateRematchUi();
    if (state.isSpectator) {
      $('grbScoreBadge').textContent = '👁️';
      $('grbScoreBadge').className = 'grb-badge pass';
      $('grbTitle').textContent = '🏁 Trận đấu đã kết thúc';
      $('grbSub').textContent = 'Bạn xem với tư cách khán giả. Bấm "Bảng Vinh Danh" để xem xếp hạng.';
      ['btnBannerPlayAgain', 'btnPlayAgain', 'btnModalPlayAgain'].forEach(id => { const b = $(id); if (b) b.style.display = 'none'; });
      return;
    }
    if (!document.body.classList.contains('live-game')) return;
    const idx = rankings.findIndex(r => r.id === state.myId);
    const rank = idx + 1;
    const n = rankings.length;
    const pts = sync.mine.total;
    const correct = state.exam30.slice(0, sync.total).filter((q, i) => state.myAnswers[i] === q.correct_option).length;
    const badge = $('grbScoreBadge');
    let win = rank <= Math.ceil(n / 2);
    let title;
    let sub = `Đúng ${correct} câu. Bấm vào từng câu để xem đáp án và giải thích.`;
    if (isTeam()) {
      const [ta, tb] = teamTotals();
      const winner = ta === tb ? -1 : (ta > tb ? 0 : 1);
      win = winner === teamOf(state.myId);
      title = winner < 0
        ? `🤝 HÒA! ${ta} – ${tb} điểm`
        : `${TEAMS[winner].dot} ${TEAMS[winner].name.toUpperCase()} THẮNG ${Math.max(ta, tb)} – ${Math.min(ta, tb)}!`;
      sub = `Bạn thuộc ${TEAMS[teamOf(state.myId)].name}, đóng góp ${pts} điểm. ${sub}`;
      badge.textContent = `${pts}đ`;
    } else if (isSurvival()) {
      const me = rankings[idx] || {};
      win = rank === 1;
      title = rank === 1 && n > 1
        ? `👑 BẠN LÀ NGƯỜI SỐNG SÓT CUỐI CÙNG! (${pts} điểm)`
        : (me.out >= 0 ? `💀 Bạn bị loại ở câu ${me.out + 1} — hạng ${rank}/${n}` : `Bạn về hạng ${rank}/${n} với ${pts} điểm`);
      badge.textContent = me.out >= 0 ? '💀' : `${pts}đ`;
    } else {
      title = n > 1
        ? `⚡ ĐUA TỐC ĐỘ — Bạn về hạng ${rank}/${n} với ${pts} điểm`
        : `⚡ ĐUA TỐC ĐỘ — ${pts} điểm`;
      badge.textContent = `${pts}đ`;
    }
    badge.className = `grb-badge ${win ? 'pass' : 'fail'}`;
    $('grbTitle').textContent = title;
    $('grbSub').textContent = sub;
    if (win && n > 1) {
      SoundEngine.playVictory();
      launchConfetti();
    }
  }

  // ---------- Chia sẻ kết quả ----------
  function shareResult() {
    const title = $('grbTitle').textContent.trim();
    const sub = $('grbSub').textContent.trim();
    const text = `${title}\n${sub}\nChơi cùng mình: ${location.origin}${location.pathname}`;
    if (navigator.share) {
      navigator.share({ title: 'Đấu Trường Lý Thuyết GPLX', text }).catch(() => {});
      return;
    }
    const done = () => toast('📋 Đã sao chép kết quả, dán vào chat để khoe bạn bè!', 'ok', 3000);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => toast('Không sao chép được', 'warn'));
    else toast('Trình duyệt không hỗ trợ sao chép', 'warn');
  }

  // ---------- Đề nghị đấu lại ----------
  function voteRematch() {
    if (state.isSolo || rematch[state.myId]) return;
    rematch[state.myId] = true;
    send('rematch', {});
    toast('🔁 Đã gửi đề nghị đấu lại cho cả phòng', 'ok', 2200);
    updateRematchUi();
  }

  function updateRematchUi() {
    if (state.isSolo) return;
    const all = Object.keys(state.players).length;
    const yes = Object.keys(rematch).filter(id => state.players[id]).length;
    const label = state.isHost
      ? `🔄 Chơi Lại Ván Mới (${yes}/${all} đồng ý)`
      : (rematch[state.myId] ? `✅ Đã đề nghị đấu lại (${yes}/${all})` : '🔁 Đề nghị đấu lại');
    ['btnPlayAgain', 'btnBannerPlayAgain', 'btnModalPlayAgain'].forEach(id => {
      const b = $(id);
      if (b) b.textContent = label;
    });
  }

  return {
    prepareSession, beginSession, clearSession, leaveAndReload, tryRejoin,
    saveGame, restoreGame, clearGame, toast, netDown, netUp,
    isReady, toggleReady, readyCounts, modeLabel, sendChat, renderChat,
    hostStart, hideCountdown, onRoomState, onFx, timeToast, onPeerProgress, onPeerSubmitted, onPeerLeft, onRestart,
    updateRace, isLive, isSyncMode, onSpectatorStart, modeRules, shareResult, buzz, questionCount, dot, teamBadge, voteRematch, updateRematchUi, poke, onExamStart, canAnswer, onAnswered, blockNav, revealNow, afterRender,
    stopSync, sortRankings, decorateResult,
    get total() { return sync.total; }
  };
})();
window.Live = Live;
