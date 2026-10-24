/**
 * Đấu Trường Lý Thuyết GPLX B/B1 - 600 Câu Realtime
 * - Socket.io tốc độ cao 1ms
 * - Lưu trữ hành vi người dùng trên localStorage (tên, avatar, lịch sử đấu, câu sai, số lần đổi đáp án)
 * - Hỗ trợ test trực tiếp trên trình duyệt chỉ với 1 click (không cần viết testcase)
 */

// ================= STORAGE KEYS =================
const STORAGE_KEYS = {
  PROFILE: 'gplx_user_profile',
  HISTORY: 'gplx_match_history',
  WRONG_QUESTIONS: 'gplx_wrong_questions',
};

// ================= GLOBAL STATE =================
const state = {
  socket: null,
  myId: null,
  isHost: false,
  roomCode: null,
  players: {},
  exam30: [],
  currentQIndex: 0,
  myAnswers: {},
  gameMode: 'standard',
  timeLimit: 1200,
  timeRemaining: 1200,
  timerInterval: null,
  startedAt: null,
  lastCursorSend: 0,
  isReviewMode: false,
  isSolo: false,
  flaggedQuestions: new Set(),
  hasSubmitted: false,
  followingPlayerId: null,
  instantFeedback: false,
  reviewFilter: 'all',
  rankings: [],
  // Thống kê hành vi trong ván hiện tại:
  behavior: {
    answerChangesCount: 0, // Số lần đổi ý chọn lại đáp án
    timePerQuestion: {},   // Thời gian xem từng câu (giây)
    questionStartTime: 0,
  }
};
window.state = state;

// ================= DOM ELEMENTS =================
const screenLobby = document.getElementById('screenLobby');
const screenWaiting = document.getElementById('screenWaiting');
const screenGame = document.getElementById('screenGame');
const screenResult = document.getElementById('screenResult');

// ================= INITIALIZE =================
function initApp() {
  ThemeEngine.init();
  loadProfileFromStorage();
  Study.init();
  registerServiceWorker();

  Live.prepareSession();

  // Kết nối Socket.io
  const socket = io();
  state.socket = socket;

  socket.on('connect_error', () => {
    showLobbyError('Không kết nối được server!');
    resetLobbyButtons();
  });

  socket.on('connect', () => {
    state.myId = socket.id;
    console.log('⚡ Realtime sẵn sàng. ID:', socket.id);
    Live.tryRejoin();
  });

  socket.on('fx', (m) => Live.onFx(m));
  socket.on('net-down', () => Live.netDown());
  socket.on('net-up', () => Live.netUp());

  socket.on('disconnect', () => {
    console.warn('⚠️ Mất kết nối đến server.');
  });

  // Lắng nghe cập nhật phòng
  socket.on('room-state', (room) => {
    state.roomCode = room.code;
    if (state.players) {
      Object.keys(room.players).forEach(pid => {
        if (state.players[pid]) {
          room.players[pid].currentQ = state.players[pid].currentQ ?? room.players[pid].currentQ;
          room.players[pid].answeredList = state.players[pid].answeredList ?? room.players[pid].answeredList;
          if (state.players[pid].totalAnswered !== undefined && (room.players[pid].totalAnswered === 0 || room.players[pid].totalAnswered === undefined)) {
            room.players[pid].totalAnswered = state.players[pid].totalAnswered;
          }
        }
      });
    }
    Live.onRoomState(state.players, room.players, room);
    state.players = room.players;
    state.gameMode = room.mode;
    state.timeLimit = room.timeLimit;
    state.isHost = (room.hostId === socket.id);

    document.getElementById('displayRoomCode').textContent = room.code;
    renderWaitingList();

    if (room.status === 'lobby' && !screenGame.classList.contains('active')) {
      showScreen(screenWaiting);
    }
    if (screenGame.classList.contains('active')) {
      updateOpponentsBar();
      updatePaletteGrid();
    }
  });

  // Trận đấu bắt đầu
  socket.on('game-started', ({ room, questions }) => {
    state.rejoining = false;
    state.roomCode = room.code || state.roomCode;
    state.gameMode = room.mode || state.gameMode;
    questions = Live.reorder(questions, room);
    Live.hideCountdown();
    if (state.isSpectator) {
      state.exam30 = questions;
      state.players = room.players;
      state.startedAt = room.startedAt;
      state.timeLimit = room.timeLimit;
      startSpectatorUI();
      return;
    }
    state.exam30 = questions;
    state.players = room.players;
    state.startedAt = room.startedAt;
    state.timeLimit = room.timeLimit;
    state.behavior = {
      answerChangesCount: 0,
      timePerQuestion: {},
      questionStartTime: Date.now(),
    };
    startExamUI();
  });

  // Chuột của đối thủ di chuyển
  socket.on('player-cursor', (data) => {
    renderRemoteCursor(data.playerId, data.name, data.avatar, data.color, data.x, data.y, data.qIndex);
  });

  // Đối thủ chọn đáp án
  socket.on('player-progress-updated', (data) => {
    if (state.players[data.playerId]) {
      state.players[data.playerId].answeredList = data.answeredList;
      state.players[data.playerId].totalAnswered = data.totalAnswered;
      if (!state.players[data.playerId].answers) {
        state.players[data.playerId].answers = {};
      }
      if (data.optionIndex !== undefined) {
        state.players[data.playerId].answers[data.qIndex] = data.optionIndex;
      }
    }

    // Nếu đang theo dõi người chơi này, cập nhật đáp án trực tiếp & ticker hành động
    if (state.followingPlayerId === data.playerId) {
      const sub = document.getElementById('fmbSub');
      if (sub) {
        const optText = data.optionIndex !== undefined ? `Đáp án ${data.optionIndex}` : '1 đáp án';
        sub.innerHTML = `Đang làm bài (${data.totalAnswered ?? 0}/30 câu) · <span class="fmb-live-ticker live-act">⚡ Vừa bấm chọn <b>${optText}</b> ở Câu ${data.qIndex + 1}</span>`;
      }
      if (data.qIndex === state.currentQIndex && data.optionIndex !== undefined) {
        showFollowerOptionSelection(data.playerId, data.qIndex, data.optionIndex);
      }
    }

    Live.onPeerProgress(data);
    updateOpponentsBar();
    updatePaletteGrid();
  });

  // Đối thủ chuyển câu
  socket.on('player-navigated', (data) => {
    if (state.players[data.playerId]) {
      state.players[data.playerId].currentQ = data.qIndex;
    }
    // Nếu đang follow người chơi này thì tự động chuyển câu theo
    if (state.followingPlayerId === data.playerId) {
      renderQuestion(data.qIndex);
      const target = state.players[data.playerId];
      const sub = document.getElementById('fmbSub');
      if (sub && target) {
        sub.innerHTML = target.submitted
          ? `Người chơi đã nộp bài (Điểm: ${target.score ?? 0}/30) · Đang xem lại câu ${data.qIndex + 1}`
          : `Đang làm bài (${target.totalAnswered ?? Object.keys(target.answers || {}).length}/30 câu) · <span class="fmb-live-ticker">👁️ Đang xem Câu ${data.qIndex + 1} (Đang đọc đề)...</span>`;
      }
    }
    updateOpponentsBar();
  });

  // Người chơi nộp bài
  socket.on('player-submitted', (data) => {
    if (data.playerId !== state.myId) Live.onPeerSubmitted(data);
    if (state.players[data.playerId]) {
      state.players[data.playerId].submitted = true;
      state.players[data.playerId].score = data.score;
      state.players[data.playerId].answers = data.answers || state.players[data.playerId].answers || {};
    }
    if (state.followingPlayerId === data.playerId) {
      const sub = document.getElementById('fmbSub');
      if (sub) {
        sub.innerHTML = `🏁 <b>${esc(data.name || state.players[data.playerId]?.name)}</b> vừa nộp bài! (Điểm: ${data.score ?? 0}/30)`;
      }
    }
    updateOpponentsBar();
  });

  // Nhận cảm xúc Realtime từ người chơi khác
  socket.on('player-reaction', (data) => {
    SoundEngine.playReaction();
    spawnFloatingEmoji(data.emoji, data.x, data.y);
  });

  // Kết thúc ván đấu
  socket.on('game-ended', ({ rankings, room, questions }) => {
    questions = Live.reorder(questions, room && room.startedAt ? room : undefined);
    Live.sortRankings(rankings);
    Live.stopSync();
    Live.clearGame();
    saveMatchResultToStorage(rankings, questions);
    showResultScreen(rankings, questions);
  });

  // Người chơi thoát phòng
  socket.on('player-left', ({ playerId, name }) => {
    Live.onPeerLeft(name || state.players[playerId]?.name);
    if (state.followingPlayerId === playerId) {
      stopFollowing();
    }
    delete state.players[playerId];
    removeRemoteCursor(playerId);
    renderWaitingList();
    updateOpponentsBar();
  });

  // Phòng restart ván mới
  socket.on('room-restarted', (room) => {
    if (state.isSpectator) {
      // Ván mới sắp bắt đầu: đưa khán giả về sảnh với mã phòng điền sẵn để vào chơi
      window.GPLX_LEAVING = true;
      window.location.href = `${window.location.pathname}?room=${room.code}`;
      return;
    }
    Live.onRestart();
    state.isReviewMode = false;
    state.hasSubmitted = false;
    stopFollowing();
    state.rankings = [];
    state.myAnswers = {};
    const banner = document.getElementById('gameResultBanner');
    if (banner) banner.style.display = 'none';
    const subBtn = document.getElementById('btnSubmitExam');
    if (subBtn) {
      subBtn.disabled = false;
      subBtn.textContent = 'Nộp Bài 📝';
    }
    const podiumModal = document.getElementById('podiumModal');
    if (podiumModal) podiumModal.classList.remove('active');

    state.players = room.players;
    renderWaitingList();
    showScreen(screenWaiting);
  });

  setupLobbyEvents();
  setupGameEvents();
  setupHistoryModalEvents();
  checkUrlParamsForAutoJoin();
}

function showScreen(screenEl) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  screenEl.classList.add('active');
}

function resetLobbyButtons() {
  const c = document.getElementById('btnCreateRoom');
  const j = document.getElementById('btnJoinRoom');
  if (c) { c.disabled = false; c.textContent = '🚀 Tạo Phòng & Bắt Đầu'; }
  if (j) { j.disabled = false; j.textContent = '🔑 Vào Thi Đấu Ngay'; }
}

function showLobbyError(msg) {
  const el = document.getElementById('lobbyError');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ================= LOCALSTORAGE: PROFILE =================
function loadProfileFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROFILE);
    if (raw) {
      const p = JSON.parse(raw);
      if (p.name) document.getElementById('playerNameInput').value = p.name;
      if (p.avatar) {
        document.querySelectorAll('.avatar-opt').forEach(btn => {
          btn.classList.toggle('selected', btn.dataset.avatar === p.avatar);
        });
      }
    }
  } catch (e) {
    console.warn('Lỗi đọc localStorage:', e);
  }
}

function saveProfileToStorage(name, avatar) {
  try {
    localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify({ name, avatar }));
  } catch (e) {}
}

function getMyProfile() {
  const nameInput = document.getElementById('playerNameInput');
  const name = nameInput.value.trim() || `Tay Lái ${Math.floor(100 + Math.random() * 900)}`;
  const avatar = document.querySelector('.avatar-opt.selected')?.dataset.avatar || '🏎️';
  saveProfileToStorage(name, avatar);
  return { name, avatar };
}

// ================= TỰ ĐỘNG VÀO PHÒNG ĐỂ TEST NHANH =================
function checkUrlParamsForAutoJoin() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('room');
  const isAuto = params.get('auto') === 'true';

  if (code) {
    document.getElementById('roomCodeInput').value = code.toUpperCase();
    document.getElementById('tabJoinBtn').click();

    if (isAuto) {
      // Đặt tên ngẫu nhiên cho tab 2 để test cực nhanh
      const randomNames = ['Lan Siêu Tốc', 'Tuấn Pro', 'Hương Biker', 'Bình Drift'];
      const randomName = randomNames[Math.floor(Math.random() * randomNames.length)];
      document.getElementById('playerNameInput').value = randomName;

      setTimeout(() => {
        document.getElementById('btnJoinRoom').click();
      }, 300);
    }
  }
}

// ================= LOBBY EVENTS =================
function setupLobbyEvents() {
  // Nạp sẵn 600 câu để Sinh tồn bốc đề tại chỗ (cùng hạt giống cho cả phòng)
  get600Questions().then(list => Live.setPool(list)).catch(() => { /* dùng đề của server */ });
  // Nhớ lựa chọn lần trước ở sảnh (chế độ, thời gian, chế độ học tập)
  const modeSel = document.getElementById('gameModeSelect');
  const timeSel = document.getElementById('gameTimeSelect');
  const instantChk = document.getElementById('chkInstantFeedback');
  try {
    const prefs = JSON.parse(localStorage.getItem('gplx_lobby_prefs') || 'null');
    if (prefs) {
      if ([...modeSel.options].some(o => o.value === prefs.mode)) modeSel.value = prefs.mode;
      if ([...timeSel.options].some(o => o.value === prefs.time)) timeSel.value = prefs.time;
      instantChk.checked = !!prefs.instant;
    }
  } catch (e) { /* ignore */ }
  // Tuỳ chọn riêng của chế độ Sinh tồn (loại câu, số mạng, tốc độ)
  const survBox = document.getElementById('survivalOpts');
  const survKind = document.getElementById('survKind');
  const survLives = document.getElementById('survLives');
  const survSpeed = document.getElementById('survSpeed');
  const survCount = document.getElementById('survCount');
  const survRegen = document.getElementById('survRegen');
  try {
    const sp = JSON.parse(localStorage.getItem('gplx_surv_prefs') || 'null');
    if (sp) {
      if ([...survKind.options].some(o => o.value === sp.k)) survKind.value = sp.k;
      if ([...survLives.options].some(o => o.value === sp.l)) survLives.value = sp.l;
      if ([...survSpeed.options].some(o => o.value === sp.s)) survSpeed.value = sp.s;
      if ([...survCount.options].some(o => o.value === sp.c)) survCount.value = sp.c;
      survRegen.checked = !!sp.g;
    }
  } catch (e) { /* ignore */ }
  const syncSurvBox = () => { survBox.style.display = /^survival/.test(modeSel.value) ? 'block' : 'none'; };
  modeSel.addEventListener('change', () => {
    // Đổi chế độ thì đặt số mạng mặc định theo chế độ (1 mạng / 2 mạng)
    if (modeSel.value === 'survival') survLives.value = '1';
    else if (modeSel.value === 'survival2') survLives.value = '2';
    syncSurvBox();
  });
  syncSurvBox();
  [survKind, survLives, survSpeed, survCount, survRegen].forEach(el => el.addEventListener('change', () => {
    try {
      localStorage.setItem('gplx_surv_prefs', JSON.stringify({ k: survKind.value, l: survLives.value, s: survSpeed.value, c: survCount.value, g: survRegen.checked }));
    } catch (e) { /* ignore */ }
  }));
  [modeSel, timeSel, instantChk].forEach(el => el.addEventListener('change', () => {
    try {
      localStorage.setItem('gplx_lobby_prefs', JSON.stringify({ mode: modeSel.value, time: timeSel.value, instant: instantChk.checked }));
    } catch (e) { /* ignore */ }
  }));

  // Phím Enter: nhập mã phòng xong vào ngay, nhập tên xong tạo/vào phòng
  document.getElementById('roomCodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btnJoinRoom').click();
  });
  document.getElementById('playerNameInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const joining = document.getElementById('tabJoinPane').classList.contains('active');
    document.getElementById(joining ? 'btnJoinRoom' : 'btnCreateRoom').click();
  });

  // Thay đổi tên / avatar tự động lưu localStorage
  document.getElementById('playerNameInput').addEventListener('input', (e) => {
    const avatar = document.querySelector('.avatar-opt.selected')?.dataset.avatar || '🏎️';
    saveProfileToStorage(e.target.value.trim(), avatar);
  });

  document.querySelectorAll('.avatar-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.avatar-opt').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const name = document.getElementById('playerNameInput').value.trim();
      saveProfileToStorage(name, btn.dataset.avatar);
    });
  });

  // Switch tabs
  const tabCreateBtn = document.getElementById('tabCreateBtn');
  const tabJoinBtn = document.getElementById('tabJoinBtn');
  const tabCreatePane = document.getElementById('tabCreatePane');
  const tabJoinPane = document.getElementById('tabJoinPane');

  tabCreateBtn.addEventListener('click', () => {
    tabCreateBtn.classList.add('active');
    tabJoinBtn.classList.remove('active');
    tabCreatePane.classList.add('active');
    tabJoinPane.classList.remove('active');
  });

  tabJoinBtn.addEventListener('click', () => {
    tabJoinBtn.classList.add('active');
    tabCreateBtn.classList.remove('active');
    tabJoinPane.classList.add('active');
    tabCreatePane.classList.remove('active');
  });

  // Chuyển đổi giao diện Sáng / Tối (Theme Mode)
  const themeToggleLobby = document.getElementById('btnThemeToggleLobby');
  if (themeToggleLobby) {
    themeToggleLobby.addEventListener('click', () => ThemeEngine.toggle());
  }
  const themeToggleWaiting = document.getElementById('btnThemeToggleWaiting');
  if (themeToggleWaiting) {
    themeToggleWaiting.addEventListener('click', () => ThemeEngine.toggle());
  }

  // Nút Tự Luyện Solo
  const btnSolo = document.getElementById('btnSoloPractice');
  if (btnSolo) {
    btnSolo.addEventListener('click', startSoloPractice);
  }

  // Bấm Tạo Phòng
  document.getElementById('btnCreateRoom').addEventListener('click', () => {
    const { name, avatar } = getMyProfile();
    let mode = document.getElementById('gameModeSelect').value;
    if (/^survival/.test(mode)) {
      mode = Live.buildMode(mode, {
        k: document.getElementById('survKind').value,
        l: document.getElementById('survLives').value,
        s: document.getElementById('survSpeed').value,
        c: document.getElementById('survCount').value,
        g: document.getElementById('survRegen').checked ? '1' : ''
      });
    }
    const timeLimit = parseInt(document.getElementById('gameTimeSelect').value, 10);

    const btn = document.getElementById('btnCreateRoom');
    btn.disabled = true;
    btn.textContent = '⏳ Đang tạo phòng...';

    if (!state.socket.connected) {
      showLobbyError('Chưa kết nối được server realtime, thử lại sau giây lát...');
      resetLobbyButtons();
      return;
    }
    state.socket.emit('create-room', { name, avatar, mode, timeLimit }, (res) => {
      btn.disabled = false;
      btn.textContent = '🚀 Tạo Phòng & Bắt Đầu';

      if (res && res.success) {
        state.roomCode = res.roomCode;
        state.isHost = true;
        Live.beginSession(res.roomCode);
        document.getElementById('displayRoomCode').textContent = res.roomCode;
        showScreen(screenWaiting);
      } else {
        showLobbyError(res?.message || 'Không thể tạo phòng!');
      }
    });
  });

  // Bấm Vào Phòng
  document.getElementById('btnJoinRoom').addEventListener('click', () => {
    const { name, avatar } = getMyProfile();
    const roomCode = document.getElementById('roomCodeInput').value.trim().toUpperCase();

    if (!roomCode) {
      showLobbyError('Vui lòng nhập mã phòng!');
      return;
    }

    const btn = document.getElementById('btnJoinRoom');
    btn.disabled = true;
    btn.textContent = '⏳ Đang kết nối...';

    if (!state.socket.connected) {
      showLobbyError('Chưa kết nối được server realtime, thử lại sau giây lát...');
      resetLobbyButtons();
      return;
    }
    state.socket.emit('join-room', { roomCode, name, avatar }, (res) => {
      btn.disabled = false;
      btn.textContent = '🔑 Vào Thi Đấu Ngay';

      if (res && res.success) {
        state.roomCode = res.roomCode;
        state.isHost = false;
        Live.beginSession(res.roomCode);
        document.getElementById('displayRoomCode').textContent = res.roomCode;
        showScreen(screenWaiting);
      } else if (res && /đang diễn ra/.test(res.message || '')) {
        // Trận đã bắt đầu: vào xem với tư cách khán giả
        startSpectating(roomCode);
      } else {
        showLobbyError(res?.message || 'Mã phòng không tồn tại hoặc đã đủ người!');
      }
    });
  });

  // Copy link phòng
  document.getElementById('btnCopyCode').addEventListener('click', () => {
    const link = `${window.location.origin}${window.location.pathname}?room=${state.roomCode}`;
    navigator.clipboard.writeText(link).then(() => {
      const hint = document.querySelector('.copy-hint');
      const old = hint.textContent;
      hint.textContent = '✅ Đã copy link phòng!';
      setTimeout(() => { hint.textContent = old; }, 2000);
    });
  });

  // Rời phòng
  document.getElementById('btnLeaveRoom').addEventListener('click', () => {
    Live.leaveAndReload();
  });

  // Bắt đầu game (Host)
  document.getElementById('btnStartGame').addEventListener('click', () => {
    Live.hostStart();
  });

  const btnReady = document.getElementById('btnReady');
  if (btnReady) btnReady.addEventListener('click', () => Live.toggleReady());

  const chatInput = document.getElementById('waitingChatInput');
  const submitChat = () => {
    Live.sendChat(chatInput.value);
    chatInput.value = '';
  };
  document.getElementById('btnSendChat').addEventListener('click', submitChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitChat();
  });

  // Về sảnh chính từ màn hình kết quả
  document.getElementById('btnBackToLobby').addEventListener('click', () => {
    Live.leaveAndReload();
  });
}

function renderWaitingList() {
  const listEl = document.getElementById('waitingPlayersList');
  const players = Object.values(state.players);

  listEl.innerHTML = players.map(p => {
    const isReady = Live.isReady(p);
    return `
    <div class="player-item">
      <div class="player-info">
        <div class="player-avatar" style="border: 2px solid ${p.color};">${p.avatar}</div>
        <div>
          <span class="player-name">${Live.dot(p.id)} ${Live.teamBadge(p.id)} ${esc(p.name)} ${p.id === state.myId ? '(Bạn)' : ''}</span>
          ${p.isHost ? '<span class="player-tag">👑 Trưởng phòng</span>' : ''}
        </div>
      </div>
      <span class="status-badge ${isReady ? 'ready' : 'waiting'}">${isReady ? '● Sẵn sàng' : '○ Chưa sẵn sàng'}</span>
    </div>`;
  }).join('');

  const rulesLine = document.getElementById('waitingModeRules');
  if (rulesLine) rulesLine.textContent = Live.modeRules(state.gameMode);
  const modeLine = document.getElementById('waitingModeLine');
  if (modeLine) {
    modeLine.textContent = `${Live.modeLabel(state.gameMode)}${Live.isSyncMode(state.gameMode) ? '' : ` · ${Math.round(state.timeLimit / 60)} phút`}`;
  }

  const { ok, all } = Live.readyCounts(state.players);
  const btnStart = document.getElementById('btnStartGame');
  const btnReady = document.getElementById('btnReady');
  if (state.isHost) {
    btnStart.style.display = 'block';
    btnStart.textContent = `🏁 Bắt Đầu Thi Đấu (${ok}/${all} sẵn sàng)`;
    if (btnReady) btnReady.style.display = 'none';
  } else {
    btnStart.style.display = 'none';
    if (btnReady) {
      btnReady.style.display = 'block';
      const me = state.players[state.myId];
      const isReady = me ? Live.isReady(me) : false;
      btnReady.classList.toggle('on', isReady);
      btnReady.textContent = isReady ? '✅ Đã sẵn sàng (bấm để hủy)' : '✅ Tôi đã sẵn sàng';
    }
  }
}

// ================= SOLO PRACTICE & QUESTIONS LOADER =================
let cachedQuestions600 = null;
async function get600Questions() {
  if (cachedQuestions600) return cachedQuestions600;
  const res = await fetch('./data/questions_600_bca.json');
  cachedQuestions600 = await res.json();
  return cachedQuestions600;
}

function generate30ClientQuestions(allQuestions, mode = 'standard') {
  function sample(arr, n) {
    return [...arr].sort(() => 0.5 - Math.random()).slice(0, n);
  }

  if (mode === 'wrong') {
    // Lặp lại ngắt quãng: câu đến hạn ôn lên trước, rồi tới các câu sai còn lại
    const { due, rest } = Study.wrongPool(allQuestions);
    if (due.length + rest.length === 0) {
      return null;
    }
    const wrongList = [...sample(due, 30), ...sample(rest, 30)].slice(0, 30);
    if (wrongList.length >= 30) {
      return wrongList.sort((a, b) => a.id - b.id);
    }
    const pickedIds = new Set(wrongList.map(q => q.id));
    const pad = sample(allQuestions.filter(q => !pickedIds.has(q.id)), 30 - wrongList.length);
    return [...wrongList, ...pad].sort((a, b) => a.id - b.id);
  }

  if (mode.startsWith('chapter:')) {
    const ch = Number(mode.split(':')[1]);
    const own = sample(allQuestions.filter(q => q.chapter === ch), 30);
    if (own.length >= 30) return own.sort((a, b) => a.id - b.id);
    const ids = new Set(own.map(q => q.id));
    return [...own, ...sample(allQuestions.filter(q => !ids.has(q.id)), 30 - own.length)];
  }

  if (mode === 'critical') {
    return sample(allQuestions.filter(q => q.is_critical), 30);
  }

  if (mode === 'signs') {
    return sample(allQuestions.filter(q => q.chapter === 5 || q.chapter === 6), 30);
  }

  const ch = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  allQuestions.forEach(q => { if (ch[q.chapter]) ch[q.chapter].push(q); });
  const pickedCritical = sample(allQuestions.filter(q => q.is_critical), 2);
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

async function startSoloPractice(opts) {
  // Có thể gọi từ màn Ôn tập với { mode, instant, timeLimit }; khi gắn vào nút bấm thì tham số là sự kiện
  opts = (opts && opts.mode) ? opts : {};
  const { name, avatar } = getMyProfile();
  const mode = opts.mode || document.getElementById('gameModeSelect').value;
  const timeLimit = opts.timeLimit || parseInt(document.getElementById('gameTimeSelect').value, 10);
  const instantFeedback = opts.instant ?? document.getElementById('chkInstantFeedback').checked;
  state.lastSoloOpts = opts.mode ? opts : null;

  if (Live.isSyncMode(mode)) {
    showLobbyError('Chế độ Đồng bộ / Sinh tồn / Đồng đội cần phòng nhiều người. Hãy tạo phòng hoặc chọn chế độ khác để luyện solo.');
    return;
  }

  const btn = document.getElementById('btnSoloPractice');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Đang nạp đề...';
  }

  try {
    const allQuestions = await get600Questions();
    const questions = generate30ClientQuestions(allQuestions, mode);

    if (!questions) {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Tự Luyện Solo'; }
      showLobbyError('Bạn chưa có câu nào làm sai trong lịch sử! Hãy chọn chế độ Chuẩn thi thử trước nhé.');
      return;
    }

    state.isSolo = true;
    state.isHost = true;
    state.myId = state.myId || ('solo_' + Math.random().toString(36).slice(2, 8));
    state.roomCode = 'SOLO';
    state.gameMode = mode;
    state.timeLimit = timeLimit;
    state.startedAt = Date.now();
    state.instantFeedback = instantFeedback;
    state.exam30 = questions;
    state.players = {
      [state.myId]: {
        id: state.myId,
        name: name,
        avatar: avatar,
        color: '#3b82f6',
        isHost: true,
        isReady: true,
        currentQ: 0,
        score: 0,
        passed: false,
        submitted: false
      }
    };
    state.behavior = {
      answerChangesCount: 0,
      timePerQuestion: {},
      questionStartTime: Date.now()
    };

    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Tự Luyện Solo';
    }

    startExamUI();
  } catch (err) {
    console.error('Lỗi khởi tạo Solo:', err);
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Tự Luyện Solo'; }
    showLobbyError('Không tải được danh sách câu hỏi: ' + err.message);
  }
}
window.startSoloPractice = startSoloPractice;

// ================= KHÁN GIẢ =================
function startSpectating(roomCode) {
  state.isSpectator = true;
  state.socket.emit('spectate-room', { roomCode }, (res) => {
    if (res && res.success) {
      state.roomCode = res.roomCode;
      document.getElementById('displayRoomCode').textContent = res.roomCode;
      Live.toast('👁️ Trận đang diễn ra — bạn vào xem với tư cách khán giả', 'ok', 4500);
    } else {
      state.isSpectator = false;
      showLobbyError(res?.message || 'Không thể vào xem phòng này!');
    }
  });
}

function startSpectatorUI() {
  state.currentQIndex = 0;
  state.myAnswers = {};
  state.isReviewMode = false;
  state.hasSubmitted = true;
  state.flaggedQuestions.clear();
  stopFollowing();
  state.rankings = [];
  Live.onSpectatorStart();

  const banner = document.getElementById('gameResultBanner');
  if (banner) banner.style.display = 'none';
  const subBtn = document.getElementById('btnSubmitExam');
  if (subBtn) {
    subBtn.disabled = true;
    subBtn.textContent = '👁️ Khán giả';
  }
  const chat = document.getElementById('quickChatBar');
  if (chat) chat.style.display = 'none';

  showScreen(screenGame);
  renderPaletteGrid();
  renderQuestion(0);
  updateOpponentsBar();
  if (!Live.isLive()) {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    state.timeRemaining = Math.max(0, state.timeLimit - elapsed);
    clearInterval(state.timerInterval);
    updateTimerDisplay();
    state.timerInterval = setInterval(() => {
      state.timeRemaining = Math.max(0, state.timeRemaining - 1);
      updateTimerDisplay();
    }, 1000);
  } else {
    document.getElementById('timerText').textContent = '👁️';
  }
  // Tự theo dõi góc nhìn của người đang dẫn đầu (người đầu tiên) để có hình ảnh ngay
  const first = Object.keys(state.players)[0];
  if (first) startFollowing(first);
}

// ================= GAMEPLAY =================
function startExamUI() {
  state.currentQIndex = 0;
  state.myAnswers = {};
  state.isReviewMode = false;
  state.hasSubmitted = false;
  state.flaggedQuestions.clear();
  stopFollowing();
  state.rankings = [];
  const resumed = Live.restoreGame();

  const banner = document.getElementById('gameResultBanner');
  if (banner) banner.style.display = 'none';
  const subBtn = document.getElementById('btnSubmitExam');
  if (subBtn) {
    subBtn.disabled = state.hasSubmitted;
    subBtn.textContent = state.hasSubmitted ? 'Đã nộp bài ✅' : 'Nộp Bài 📝';
  }

  showScreen(screenGame);

  renderPaletteGrid();
  const handledByLive = Live.onExamStart(resumed);
  renderQuestion(state.currentQIndex);
  updateOpponentsBar();
  if (state.hasSubmitted) {
    document.getElementById('timerText').textContent = 'ĐÃ NỘP';
    return;
  }
  if (!handledByLive) startTimer(resumed);
  if (resumed) Live.toast('🔄 Đã khôi phục bài làm của bạn', 'ok');
}

function startTimer(resumed = false) {
  clearInterval(state.timerInterval);
  state.timeRemaining = state.timeLimit;
  if (resumed && state.startedAt) {
    // Vào lại giữa trận: tính thời gian còn lại từ lúc bắt đầu
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    state.timeRemaining = Math.max(1, Math.min(state.timeLimit, state.timeLimit - elapsed));
  }
  updateTimerDisplay();

  state.timerInterval = setInterval(() => {
    state.timeRemaining--;
    updateTimerDisplay();
    Live.timeToast(state.timeRemaining);

    if (state.timeRemaining <= 0) {
      clearInterval(state.timerInterval);
      handleSubmitExam();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const m = Math.floor(state.timeRemaining / 60);
  const s = state.timeRemaining % 60;
  const txt = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  document.getElementById('timerText').textContent = txt;

  if (state.timeRemaining <= 60 && state.timeRemaining > 0) {
    document.getElementById('gameTimer').style.borderColor = 'var(--danger)';
    document.getElementById('timerText').style.color = '#f87171';
    SoundEngine.playTick();
  }
}

function renderQuestion(index) {
  if (!state.exam30 || !state.exam30[index]) return;
  if (Live.blockNav(index)) return;

  if (state.currentQIndex !== undefined && state.currentQIndex !== null && state.currentQIndex !== index) {
    SoundEngine.playNav();
  }

  // Ghi nhận thời gian xem câu trước đó
  const now = Date.now();
  if (state.behavior.questionStartTime > 0) {
    const elapsed = Math.round((now - state.behavior.questionStartTime) / 1000);
    state.behavior.timePerQuestion[state.currentQIndex] = (state.behavior.timePerQuestion[state.currentQIndex] || 0) + elapsed;
  }
  state.behavior.questionStartTime = now;
  state.currentQIndex = index;
  if (state.players && state.players[state.myId]) {
    state.players[state.myId].currentQ = index;
  }
  updateOpponentsBar();

  const q = state.exam30[index];
  document.getElementById('qBadgeNum').textContent = `Câu ${index + 1} / 30`;
  document.getElementById('qBadgeChapter').textContent = `Chương ${q.chapter}: ${q.chapter_name || ''}`;

  const critBadge = document.getElementById('qBadgeCritical');
  critBadge.style.display = q.is_critical ? 'inline-block' : 'none';

  // Trạng thái cắm cờ (Flag)
  const isFlagged = state.flaggedQuestions.has(index);
  const flagBtn = document.getElementById('btnFlagQuestion');
  if (flagBtn) {
    flagBtn.classList.toggle('active', isFlagged);
    flagBtn.innerHTML = isFlagged ? '🚩 Đã cắm cờ' : '🏳️ Cắm cờ';
    flagBtn.title = isFlagged ? 'Bấm để bỏ cờ (Phím F)' : 'Đánh dấu cờ câu phân vân (Phím F)';
  }

  document.getElementById('qText').textContent = q.question;

  // Ảnh minh họa
  const imgBox = document.getElementById('qImageBox');
  const imgEl = document.getElementById('qImage');
  if (q.image) {
    imgBox.style.display = 'block';
    imgEl.src = `./${q.image}`;
  } else {
    imgBox.style.display = 'none';
    imgEl.src = '';
  }

  // Danh sách lựa chọn
  const optionsContainer = document.getElementById('optionsContainer');
  const mySelected = state.myAnswers[index];
  const isRevealed = state.isReviewMode || (state.instantFeedback && mySelected !== undefined) || Live.revealNow(index);

  // Cập nhật huy hiệu kết quả trên thanh badge (✓ Đúng / ✗ Sai)
  const resultPill = document.getElementById('qBadgeResult');
  if (resultPill) {
    if (isRevealed) {
      resultPill.style.display = 'inline-flex';
      const isCorrect = (mySelected === q.correct_option);
      if (mySelected === undefined) {
        resultPill.className = 'q-result-pill unanswered';
        resultPill.textContent = '⚪ CHƯA LÀM CÂU NÀY';
      } else if (isCorrect) {
        resultPill.className = 'q-result-pill pass';
        resultPill.textContent = '✓ BẠN TRẢ LỜI ĐÚNG';
      } else {
        resultPill.className = 'q-result-pill fail';
        resultPill.textContent = q.is_critical ? '✗ SAI CÂU ĐIỂM LIỆT ⚠️' : '✗ BẠN TRẢ LỜI SAI';
      }
    } else {
      resultPill.style.display = 'none';
    }
  }

  // Cập nhật Hộp giải thích chi tiết & Căn cứ pháp lý trực tiếp trên câu hỏi
  const expBox = document.getElementById('qExplanationBox');
  const expText = document.getElementById('qExplanationText');
  if (expBox && expText) {
    if (isRevealed) {
      expBox.style.display = 'block';
      expText.textContent = q.explanation || 'Quy chuẩn theo Thông tư 12/2025/TT-BCA và Luật Trật tự, An toàn giao thông đường bộ 2024.';
    } else {
      expBox.style.display = 'none';
    }
  }

  optionsContainer.innerHTML = q.options.map((opt, optIdx) => {
    const optNum = optIdx + 1;
    const isSelected = mySelected === optNum;
    const isCorrectOption = (optNum === q.correct_option);

    let cardCls = 'option-card';
    let myTag = '';

    if (isRevealed) {
      if (isCorrectOption) {
        cardCls += ' review-correct';
      } else if (isSelected && !isCorrectOption) {
        cardCls += ' review-wrong';
      }

      if (isSelected) {
        if (isCorrectOption) {
          myTag = '<span class="my-choice-tag pass">✓ Lựa chọn của bạn (ĐÚNG)</span>';
        } else {
          myTag = '<span class="my-choice-tag fail">✗ Lựa chọn của bạn (SAI)</span>';
        }
      }
    } else if (isSelected) {
      cardCls += ' selected';
    }

    // Hiển thị lựa chọn của người chơi khác (khi đã kết thúc trận)
    let opponentsHtml = '';
    if (state.isReviewMode && state.rankings && state.rankings.length > 0) {
      const opponentsPicked = state.rankings.filter(p => p.id !== state.myId && p.answers?.[index] === optNum);
      opponentsHtml = opponentsPicked.map(p => `
        <span class="op-choice-badge ${isCorrectOption ? '' : 'wrong-pick'}" style="background: ${p.color};">
          ${p.avatar} ${esc(p.name)} ${isCorrectOption ? '✓' : '✗'}
        </span>
      `).join('');
    } else if (Live.revealNow(index)) {
      opponentsHtml = Object.values(state.players)
        .filter(p => p.id !== state.myId && p.answers?.[index] === optNum)
        .map(p => `
          <span class="op-choice-badge ${isCorrectOption ? '' : 'wrong-pick'}" style="background: ${p.color};">
            ${p.avatar} ${esc(p.name)} ${isCorrectOption ? '✓' : '✗'}
          </span>
        `).join('');
    }

    return `
      <div class="${cardCls}" id="optCard-${index}-${optNum}" data-opt="${optNum}">
        <span class="opt-num">${optNum}</span>
        <span class="opt-text">${opt}</span>
        ${isRevealed && isCorrectOption ? '<span class="correct-badge-pill">✓ ĐÁP ÁN ĐÚNG</span>' : ''}
        ${myTag}
        <div class="opt-opponents-tag" id="optTag-${index}-${optNum}">
          ${opponentsHtml}
        </div>
      </div>
    `;
  }).join('');

  if (!state.isReviewMode && !state.hasSubmitted) {
    optionsContainer.querySelectorAll('.option-card').forEach(card => {
      card.addEventListener('click', () => {
        const optNum = parseInt(card.dataset.opt, 10);
        selectMyAnswer(index, optNum);
      });
    });
  }

  // Nếu đang theo dõi một đối thủ, hiển thị lựa chọn của người đó ở câu này (nếu có)
  if (state.followingPlayerId) {
    const fp = state.players[state.followingPlayerId];
    if (fp && fp.answers && fp.answers[index] !== undefined) {
      showFollowerOptionSelection(state.followingPlayerId, index, fp.answers[index]);
    }
  }

  document.getElementById('btnPrevQ').disabled = index <= 0;
  document.getElementById('btnNextQ').disabled = index >= 29;

  updatePaletteCurrent(index);
  Live.afterRender(index);
  Live.saveGame();

  // Gửi vị trí câu đang xem
  if (!state.isSpectator) state.socket.emit('navigate-question', { qIndex: index });
}

function selectMyAnswer(qIndex, optionIndex) {
  if (state.isReviewMode || state.hasSubmitted) return;
  if (!Live.canAnswer(qIndex)) return;

  SoundEngine.playSelect();

  // Ghi nhận hành vi đổi ý chọn đáp án khác
  if (state.myAnswers[qIndex] !== undefined && state.myAnswers[qIndex] !== optionIndex) {
    state.behavior.answerChangesCount++;
  }

  state.myAnswers[qIndex] = optionIndex;
  Live.onAnswered(qIndex, optionIndex);

  // Báo động đỏ khi phạm câu điểm liệt trong Chế độ Học tập
  const q = state.exam30[qIndex];
  if (state.instantFeedback && q && q.is_critical && optionIndex !== q.correct_option) {
    SoundEngine.playCriticalAlert();
    const pane = document.querySelector('.question-pane');
    if (pane) {
      pane.classList.remove('shake-screen');
      void pane.offsetWidth;
      pane.classList.add('shake-screen');
    }
  }

  renderQuestion(qIndex);
  updatePaletteGrid();

  // Phát tín hiệu Realtime cho tất cả người chơi (nếu không phải solo)
  if (!state.isSolo && state.socket) {
    state.socket.emit('select-answer', {
      qIndex: qIndex,
      optionIndex: optionIndex
    });
  }
}

function updateOpponentsBar() {
  const bar = document.getElementById('liveOpponentsBar');
  if (!bar) return;
  const players = Object.values(state.players);

  bar.innerHTML = players.map(p => {
    const isMe = p.id === state.myId;
    const answeredCount = isMe 
      ? Object.keys(state.myAnswers).length 
      : (p.totalAnswered ?? p.answeredList?.length ?? Object.keys(p.answers || {}).length);
    const total = Live.questionCount();
    const pct = Math.round((answeredCount / total) * 100);
    const curQIndex = isMe ? state.currentQIndex : (p.currentQ ?? 0);
    const curQNum = (curQIndex ?? 0) + 1;

    let statusText = '';
    if (state.isReviewMode || p.submitted) {
      if (Live.isLive()) {
        statusText = `Đã xong · Đang xem: C${curQNum}`;
      } else if (p.score !== undefined && p.score !== null) {
        const badge = p.passed ? '🎉 Đạt' : (p.failedCritical ? '⚠️ Liệt' : '❌ Rớt');
        statusText = `Điểm: ${p.score}/30 (${badge}) · Đang xem: C${curQNum}`;
      } else {
        statusText = `Đã nộp bài · Đang xem: C${curQNum}`;
      }
    } else {
      statusText = `Đã làm: ${answeredCount}/${total} câu · Đang xem: C${curQNum}`;
    }

    const isFollowing = state.followingPlayerId === p.id;
    const canFollow = (state.hasSubmitted || state.isReviewMode) && !isMe;

    let followBtnHtml = '';
    if (canFollow) {
      if (isFollowing) {
        followBtnHtml = `<button type="button" class="btn-follow-toggle active" data-pid="${p.id}" title="Bấm để dừng theo dõi">👁️ Đang theo dõi</button>`;
      } else {
        followBtnHtml = `<button type="button" class="btn-follow-toggle" data-pid="${p.id}" title="Bấm để theo dõi góc nhìn người này">👁️ Theo dõi</button>`;
      }
    }

    return `
      <div class="opponent-card ${isMe ? 'me' : ''} ${isFollowing ? 'following' : ''}" data-pid="${p.id}" data-can-follow="${canFollow}" style="${canFollow ? 'cursor: pointer;' : ''}" title="${canFollow ? (isFollowing ? 'Bấm để dừng theo dõi' : 'Bấm để theo dõi góc nhìn của ' + esc(p.name)) : ''}">
        <span class="op-avatar">${p.avatar}</span>
        <div class="op-meta">
          <div class="op-name">
            <span class="op-color-dot" style="background: ${p.color};"></span>
            <span>${esc(p.name)}${isMe ? ' (Bạn)' : ''}</span>
            ${followBtnHtml}
          </div>
          <div class="op-progress-txt">
            ${statusText}
          </div>
          <div class="op-progress-bar">
            <div class="op-progress-fill" style="width: ${pct}%; background: ${p.color};"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  Live.updateRace();

  bar.querySelectorAll('.btn-follow-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = btn.dataset.pid;
      if (state.followingPlayerId === pid) {
        stopFollowing();
      } else {
        startFollowing(pid);
      }
    });
  });

  bar.querySelectorAll('.opponent-card[data-can-follow="true"]').forEach(card => {
    card.addEventListener('click', () => {
      const pid = card.dataset.pid;
      if (state.followingPlayerId === pid) {
        stopFollowing();
      } else {
        startFollowing(pid);
      }
    });
  });
}

// ================= SPECTATOR / FOLLOW MODE =================
function showFollowerOptionSelection(playerId, qIndex, optionIndex) {
  const p = state.players[playerId];
  if (!p) return;
  // Xóa viền highlight trước đó ở câu này
  for (let i = 1; i <= 4; i++) {
    const card = document.getElementById(`optCard-${qIndex}-${i}`);
    const tag = document.getElementById(`optTag-${qIndex}-${i}`);
    if (card) {
      card.classList.remove('followed-picked');
      if (!card.classList.contains('review-correct') && !card.classList.contains('review-wrong') && !card.classList.contains('selected')) {
        card.style.borderColor = '';
        card.style.boxShadow = '';
      }
    }
    if (tag) {
      const existingFollowBadge = tag.querySelector('.follow-choice-badge');
      if (existingFollowBadge) existingFollowBadge.remove();
    }
  }

  const targetCard = document.getElementById(`optCard-${qIndex}-${optionIndex}`);
  const targetTag = document.getElementById(`optTag-${qIndex}-${optionIndex}`);
  if (targetCard) {
    targetCard.classList.add('followed-picked');
    targetCard.style.borderColor = p.color || '#3b82f6';
    targetCard.style.boxShadow = `0 0 16px ${p.color || '#3b82f6'}66`;
  }
  if (targetTag) {
    const badge = document.createElement('span');
    badge.className = 'follow-choice-badge';
    badge.style.background = p.color || '#3b82f6';
    badge.innerHTML = `${p.avatar || '🏎️'} ${esc(p.name)} đã chọn`;
    targetTag.appendChild(badge);
  }
}

function clearFollowerOptionSelection() {
  document.querySelectorAll('.option-card.followed-picked').forEach(card => {
    card.classList.remove('followed-picked');
    if (!card.classList.contains('review-correct') && !card.classList.contains('review-wrong') && !card.classList.contains('selected')) {
      card.style.borderColor = '';
      card.style.boxShadow = '';
    }
  });
  document.querySelectorAll('.follow-choice-badge').forEach(badge => badge.remove());
}

function startFollowing(pid) {
  if (!state.hasSubmitted && !state.isReviewMode) return;
  const target = state.players[pid];
  if (!target) return;

  state.followingPlayerId = pid;
  const targetQ = target.currentQ ?? 0;

  const banner = document.getElementById('followModeBanner');
  if (banner) {
    banner.style.display = 'flex';
    const av = document.getElementById('fmbAvatar');
    if (av) av.textContent = target.avatar || '🏎️';
    const nm = document.getElementById('fmbName');
    if (nm) nm.textContent = target.name;
    const sub = document.getElementById('fmbSub');
    if (sub) {
      sub.innerHTML = target.submitted
        ? `Người chơi đã nộp bài (Điểm: ${target.score ?? 0}/30) · Đang xem lại câu ${targetQ + 1}`
        : `Đang làm bài (${target.totalAnswered ?? Object.keys(target.answers || {}).length}/30 câu) · <span class="fmb-live-ticker">👁️ Đang xem Câu ${targetQ + 1}</span>`;
    }
  }

  renderQuestion(targetQ);
  updateOpponentsBar();
}

function stopFollowing() {
  state.followingPlayerId = null;
  clearFollowerOptionSelection();
  const banner = document.getElementById('followModeBanner');
  if (banner) banner.style.display = 'none';
  document.querySelectorAll('.cursor-tag.live-spectate').forEach(tag => {
    tag.classList.remove('live-spectate');
  });
  updateOpponentsBar();
}
window.startFollowing = startFollowing;
window.stopFollowing = stopFollowing;

function toggleFlag(index) {
  if (state.isReviewMode) return;
  if (state.flaggedQuestions.has(index)) {
    state.flaggedQuestions.delete(index);
  } else {
    state.flaggedQuestions.add(index);
    SoundEngine.playNav();
  }
  renderQuestion(index);
  updatePaletteGrid();
  Live.saveGame();
}
window.toggleFlag = toggleFlag;

function updateOptionOpponentBadges() {
  const qIndex = state.currentQIndex;
  const players = Object.values(state.players);

  for (let optNum = 1; optNum <= 4; optNum++) {
    const container = document.getElementById(`optTag-${qIndex}-${optNum}`);
    if (container) container.innerHTML = '';
  }

  players.forEach(p => {
    const chosenOpt = p.answers?.[qIndex];
    if (chosenOpt) {
      const container = document.getElementById(`optTag-${qIndex}-${chosenOpt}`);
      if (container) {
        const badge = document.createElement('span');
        badge.className = 'op-choice-badge';
        badge.style.background = p.color;
        badge.innerHTML = `${p.avatar} ${esc(p.name)}`;
        container.appendChild(badge);
      }
    }
  });
}

function renderPaletteGrid() {
  const grid = document.getElementById('paletteGrid');
  let html = '';

  for (let i = 0; i < 30; i++) {
    html += `
      <button type="button" class="q-pallet-btn" id="palletBtn-${i}" data-idx="${i}">
        <span>${i + 1}</span>
        <span class="pallet-flag-icon" id="palletFlag-${i}" style="display: none;">🚩</span>
        <div class="pallet-dots-wrap" id="palletDots-${i}"></div>
      </button>
    `;
  }

  grid.innerHTML = html;

  grid.querySelectorAll('.q-pallet-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.followingPlayerId) stopFollowing();
      const idx = parseInt(btn.dataset.idx, 10);
      renderQuestion(idx);
    });
  });

  updatePaletteGrid();
}

function updatePaletteCurrent(index) {
  document.querySelectorAll('.q-pallet-btn').forEach((btn, idx) => {
    btn.classList.toggle('current', idx === index);
  });
}

function updatePaletteGrid() {
  const players = Object.values(state.players);

  // Nếu đang ở chế độ xem lại kết quả: Tô màu trực tiếp từng nút câu hỏi (Xanh lá / Đỏ / Điểm liệt)
  if (state.isReviewMode && state.exam30 && state.exam30.length > 0) {
    for (let i = 0; i < 30; i++) {
      const btn = document.getElementById(`palletBtn-${i}`);
      const dotsWrap = document.getElementById(`palletDots-${i}`);
      if (!btn) continue;

      const q = state.exam30[i];
      if (!q) continue;
      const myChoice = state.myAnswers[i];
      const isCorrect = (myChoice === q.correct_option);
      const isCritical = q.is_critical;

      btn.classList.remove('my-answered', 'rev-correct', 'rev-wrong', 'rev-critical-wrong', 'rev-unanswered');

      if (myChoice === undefined) {
        btn.classList.add('rev-unanswered');
        btn.title = `Câu ${i + 1}: Bạn chưa làm`;
      } else if (isCorrect) {
        btn.classList.add('rev-correct');
        btn.title = `Câu ${i + 1}: Bạn trả lời ĐÚNG ✓`;
      } else if (isCritical) {
        btn.classList.add('rev-critical-wrong');
        btn.title = `Câu ${i + 1}: Bạn SAI CÂU ĐIỂM LIỆT ⚠️`;
      } else {
        btn.classList.add('rev-wrong');
        btn.title = `Câu ${i + 1}: Bạn trả lời SAI ✗`;
      }

      if (dotsWrap && state.rankings && state.rankings.length > 0) {
        dotsWrap.innerHTML = state.rankings
          .filter(p => p.id !== state.myId && p.answers && p.answers[i] !== undefined)
          .map(p => {
            const pRight = p.answers[i] === q.correct_option;
            return `<span class="pallet-dot" style="background: ${pRight ? '#10b981' : '#ef4444'};" title="${esc(p.name)}: ${pRight ? 'Đúng' : 'Sai'}"></span>`;
          }).join('');
      }
    }
    return;
  }

  // Chế độ đang thi đấu bình thường
  for (let i = 0; i < 30; i++) {
    const btn = document.getElementById(`palletBtn-${i}`);
    const dotsWrap = document.getElementById(`palletDots-${i}`);
    const flagEl = document.getElementById(`palletFlag-${i}`);
    if (!btn || !dotsWrap) continue;

    const myAnswered = state.myAnswers[i] !== undefined;
    btn.classList.toggle('my-answered', myAnswered);

    // Ván đồng bộ: tô xanh/đỏ theo kết quả từng câu, mờ các câu sau khi bị loại
    if (Live.isLive()) {
      const r = Live.paletteRes(i);
      btn.classList.toggle('rev-correct', r === 'ok');
      btn.classList.toggle('rev-wrong', r === 'bad');
      btn.classList.toggle('skipped', r === 'skip');
    }

    const isFlagged = state.flaggedQuestions.has(i);
    btn.classList.toggle('flagged', isFlagged);
    if (flagEl) flagEl.style.display = isFlagged ? 'block' : 'none';

    // Chấm màu của những người chơi khác đã làm xong câu này
    dotsWrap.innerHTML = players
      .filter(p => {
        if (p.id === state.myId) return false;
        return (p.answeredList && p.answeredList.includes(i)) || (p.answers && p.answers[i] !== undefined);
      })
      .map(p => `<span class="pallet-dot" style="background: ${p.color};" title="${esc(p.name)} đã làm câu này"></span>`)
      .join('');
  }
}

function registerServiceWorker() {
  // Chỉ đăng ký trên bản triển khai (hoặc khi bật thủ công) để không cache nhầm lúc phát triển local
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  let forced = false;
  try { forced = localStorage.getItem('gplx_sw') === '1'; } catch (e) { /* ignore */ }
  if ('serviceWorker' in navigator && (!isLocal || forced)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ================= REALTIME MOUSE CURSOR =================
function setupGameEvents() {
  const arena = document.getElementById('arenaContainer');

  // Vuốt ngang trên điện thoại để chuyển câu
  const pane = document.querySelector('.question-pane');
  let touch = null;
  pane.addEventListener('touchstart', (e) => {
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  pane.addEventListener('touchend', (e) => {
    if (!touch || document.body.classList.contains('live-mode') || state.isSpectator) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) {
      document.getElementById(dx < 0 ? 'btnNextQ' : 'btnPrevQ').click();
    }
  }, { passive: true });

  arena.addEventListener('mousemove', (e) => {
    if (state.isSpectator) return;
    const now = Date.now();
    if (now - state.lastCursorSend < 90) return; // ~11 lần/giây: đủ mượt nhờ nội suy, nhẹ cho Realtime
    state.lastCursorSend = now;

    const rect = arena.getBoundingClientRect();
    const xPercent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const yPercent = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    state.socket.emit('cursor-move', {
      xPercent: xPercent,
      yPercent: yPercent,
      qIndex: state.currentQIndex
    });
  });

  document.getElementById('btnPrevQ').addEventListener('click', () => {
    if (state.followingPlayerId) stopFollowing();
    if (state.currentQIndex > 0) {
      renderQuestion(state.currentQIndex - 1);
    }
  });

  document.getElementById('btnNextQ').addEventListener('click', () => {
    if (state.followingPlayerId) stopFollowing();
    if (state.currentQIndex < 29) {
      renderQuestion(state.currentQIndex + 1);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!screenGame.classList.contains('active')) return;

    if (e.key === 'ArrowLeft' && state.currentQIndex > 0) {
      if (state.followingPlayerId) stopFollowing();
      renderQuestion(state.currentQIndex - 1);
    } else if (e.key === 'ArrowRight' && state.currentQIndex < 29) {
      if (state.followingPlayerId) stopFollowing();
      renderQuestion(state.currentQIndex + 1);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      const optNum = parseInt(e.key, 10);
      const currentQuestion = state.exam30[state.currentQIndex];
      if (currentQuestion && optNum <= currentQuestion.options.length) {
        selectMyAnswer(state.currentQIndex, optNum);
      }
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFlag(state.currentQIndex);
    }
  });

  const btnFlagQ = document.getElementById('btnFlagQuestion');
  if (btnFlagQ) {
    btnFlagQ.addEventListener('click', () => toggleFlag(state.currentQIndex));
  }

  const btnStopFollow = document.getElementById('btnStopFollow');
  if (btnStopFollow) {
    btnStopFollow.addEventListener('click', () => stopFollowing());
  }

  document.getElementById('btnSubmitExam').addEventListener('click', () => {
    const answeredCount = Object.keys(state.myAnswers).length;
    const confirmMsg = answeredCount < 30
      ? `Bạn mới hoàn thành ${answeredCount}/30 câu. Bạn có chắc chắn muốn nộp bài sớm không?`
      : 'Bạn có chắc chắn muốn nộp bài để xem điểm không?';

    if (confirm(confirmMsg)) {
      handleSubmitExam();
    }
  });

  // Bật/Tắt âm thanh
  const soundBtn = document.getElementById('btnToggleSound');
  if (soundBtn) {
    soundBtn.textContent = SoundEngine.enabled ? '🔊' : '🔇';
    soundBtn.addEventListener('click', () => SoundEngine.toggle());
  }

  // Đổi giao diện Sáng / Tối trong phòng đấu
  const themeToggleGame = document.getElementById('btnThemeToggleGame');
  if (themeToggleGame) {
    themeToggleGame.addEventListener('click', () => ThemeEngine.toggle());
  }

  // Thả cảm xúc Realtime
  document.querySelectorAll('.qr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      SoundEngine.playReaction();
      spawnFloatingEmoji(emoji);
      state.socket.emit('send-reaction', { emoji });
    });
  });

  document.querySelectorAll('.qc-btn').forEach(btn => {
    btn.addEventListener('click', () => Live.sendChat(btn.dataset.text));
  });

  document.getElementById('btnPlayAgain').addEventListener('click', () => {
    if (state.isSolo) {
      startSoloPractice(state.lastSoloOpts);
      return;
    }
    if (state.isHost) {
      state.socket.emit('restart-game');
    } else {
      Live.voteRematch();
    }
  });

  // Tương tác trên Banner kết quả trực tiếp
  document.querySelectorAll('.grb-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.grb-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.dataset.filter;
      state.reviewFilter = filter;

      if (filter === 'wrong') {
        const firstWrong = state.exam30.slice(0, Live.questionCount()).findIndex((q, i) => state.myAnswers[i] !== q.correct_option);
        if (firstWrong !== -1) {
          renderQuestion(firstWrong);
        } else {
          alert('Tuyệt vời! Bạn không làm sai câu nào.');
        }
      } else if (filter === 'critical') {
        const firstCrit = state.exam30.slice(0, Live.questionCount()).findIndex((q) => q.is_critical);
        if (firstCrit !== -1) renderQuestion(firstCrit);
      } else {
        renderQuestion(0);
      }
    });
  });

  const btnShare = document.getElementById('btnShareResult');
  if (btnShare) btnShare.addEventListener('click', () => Live.shareResult());

  const btnOpenPodium = document.getElementById('btnOpenPodium');
  if (btnOpenPodium) {
    btnOpenPodium.addEventListener('click', () => {
      document.getElementById('podiumModal').classList.add('active');
    });
  }

  const btnClosePodiumModal = document.getElementById('btnClosePodiumModal');
  if (btnClosePodiumModal) {
    btnClosePodiumModal.addEventListener('click', () => {
      document.getElementById('podiumModal').classList.remove('active');
    });
  }

  const btnModalBackToQuestion = document.getElementById('btnModalBackToQuestion');
  if (btnModalBackToQuestion) {
    btnModalBackToQuestion.addEventListener('click', () => {
      document.getElementById('podiumModal').classList.remove('active');
    });
  }

  const btnBannerPlayAgain = document.getElementById('btnBannerPlayAgain');
  if (btnBannerPlayAgain) {
    btnBannerPlayAgain.addEventListener('click', () => {
      if (state.isSolo) {
        startSoloPractice(state.lastSoloOpts);
        return;
      }
      if (state.isHost) {
        state.socket.emit('restart-game');
      } else {
        Live.voteRematch();
      }
    });
  }

  const btnModalPlayAgain = document.getElementById('btnModalPlayAgain');
  if (btnModalPlayAgain) {
    btnModalPlayAgain.addEventListener('click', () => {
      document.getElementById('podiumModal').classList.remove('active');
      if (state.isSolo) {
        startSoloPractice(state.lastSoloOpts);
        return;
      }
      if (state.isHost) {
        state.socket.emit('restart-game');
      } else {
        Live.voteRematch();
      }
    });
  }

  const btnBannerLobby = document.getElementById('btnBannerLobby');
  if (btnBannerLobby) {
    btnBannerLobby.addEventListener('click', () => {
      Live.leaveAndReload();
    });
  }
}

function renderRemoteCursor(playerId, name, avatar, color, xPercent, yPercent, qIndex) {
  if (playerId === state.myId) return;
  const known = state.players[playerId];
  if (known) {
    name = name || known.name;
    avatar = avatar || known.avatar;
    color = color || known.color;
  }
  name = esc(name || '');
  avatar = avatar || '🏎️';
  color = color || '#3b82f6';

  const overlay = document.getElementById('cursorOverlay');
  let cursorEl = document.getElementById(`cursor-${playerId}`);

  if (!cursorEl) {
    cursorEl = document.createElement('div');
    cursorEl.id = `cursor-${playerId}`;
    cursorEl.className = 'remote-cursor';
    cursorEl.innerHTML = `
      <svg class="cursor-pointer" viewBox="0 0 24 24" fill="${color}">
        <path d="M4 2l16 12-7 1.5 4 7-3 1.5-4-7-6 4V2z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div class="cursor-tag" style="border-color: ${color};">
        ${avatar} ${name}
      </div>
    `;
    overlay.appendChild(cursorEl);
  }

  const isFollowed = (state.followingPlayerId === playerId);
  const tagEl = cursorEl.querySelector('.cursor-tag');
  if (tagEl) {
    tagEl.classList.toggle('live-spectate', isFollowed);
    if (isFollowed) {
      tagEl.innerHTML = `<span class="live-pulse-dot">🔴</span> LIVE: ${avatar} ${name}`;
    } else {
      tagEl.innerHTML = `${avatar} ${name}`;
    }
  }

  cursorEl.style.zIndex = isFollowed ? '100' : '50';
  cursorEl.style.opacity = (state.followingPlayerId && !isFollowed) ? '0.2' : '1';
  // Làm mượt: thời gian trượt bằng đúng khoảng cách giữa 2 lần cập nhật
  const now = Date.now();
  const dt = cursorEl._lastAt ? now - cursorEl._lastAt : 120;
  cursorEl._lastAt = now;
  cursorEl.style.transitionDuration = `${Math.min(650, Math.max(60, dt))}ms`;
  cursorEl.style.left = `${xPercent * 100}%`;
  cursorEl.style.top = `${yPercent * 100}%`;
}

function removeRemoteCursor(playerId) {
  const el = document.getElementById(`cursor-${playerId}`);
  if (el) el.remove();
}

function handleSubmitExam() {
  if (state.isSpectator) return;
  clearInterval(state.timerInterval);
  Live.stopSync();
  state.hasSubmitted = true;
  Live.saveGame();
  document.getElementById('btnSubmitExam').disabled = true;
  document.getElementById('btnSubmitExam').textContent = 'Đã nộp bài ✅';

  if (state.isSolo) {
    const submitTime = Math.round((Date.now() - state.startedAt) / 1000);
    let score = 0;
    let failedCritical = false;

    state.exam30.forEach((q, idx) => {
      const chosen = state.myAnswers[idx];
      if (chosen === q.correct_option) {
        score++;
      } else if (q.is_critical && chosen !== undefined) {
        failedCritical = true;
      }
    });

    const passed = (score >= 27) && !failedCritical;
    const myProfile = getMyProfile();
    const myRecord = {
      id: state.myId,
      name: myProfile.name,
      avatar: myProfile.avatar,
      color: '#3b82f6',
      score: score,
      passed: passed,
      failedCritical: failedCritical,
      submitTime: submitTime,
      answers: state.myAnswers
    };

    const rankings = [myRecord];
    saveMatchResultToStorage(rankings, state.exam30);
    showResultScreen(rankings, state.exam30);
    return;
  }

  state.socket.emit('submit-exam');
  updateOpponentsBar();
}

// ================= LOCALSTORAGE: SAVE MATCH RESULT & WRONG QUESTIONS =================
function saveMatchResultToStorage(rankings, questions) {
  const myRecord = rankings.find(p => p.id === state.myId);
  if (!myRecord) return;
  const isLive = Live.isLive();
  // Sinh tồn: chỉ tính các câu đã chơi tới lúc bị loại (không đẩy câu chưa thấy vào danh sách câu sai)
  if (isLive) questions = questions.slice(0, Live.seenCount());

  try {
    // 1. Lưu vào danh sách lịch sử trận đấu (ván đồng bộ chỉ có 15 câu nên không tính vào tỉ lệ đạt)
    const history = JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) || '[]');
    const newEntry = {
      id: Date.now(),
      date: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date().toLocaleDateString('vi-VN'),
      roomCode: state.roomCode,
      score: myRecord.score,
      passed: myRecord.passed,
      failedCritical: myRecord.failedCritical,
      submitTime: myRecord.submitTime || 0,
      answerChanges: state.behavior.answerChangesCount,
      totalQuestions: 30
    };
    const isChapterPractice = String(state.gameMode).startsWith('chapter:');
    if (!isLive && !isChapterPractice) {
      history.unshift(newEntry);
      localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history.slice(0, 30))); // Lưu tối đa 30 trận gần nhất
    }

    // 2. Câu sai (lặp lại ngắt quãng), thống kê theo chương, chuỗi ngày, XP
    Study.recordResult(questions, state.myAnswers, state.gameMode === 'standard' && myRecord.passed);

  } catch (err) {
    console.warn('Lỗi lưu lịch sử localStorage:', err);
  }
}

// ================= LOCALSTORAGE: MODAL UI & ANALYTICS =================
function setupHistoryModalEvents() {
  const modal = document.getElementById('historyModal');
  const btnOpen = document.getElementById('btnOpenHistory');
  const btnClose = document.getElementById('btnCloseHistory');
  const btnClear = document.getElementById('btnClearHistory');

  btnOpen.addEventListener('click', () => {
    renderHistoryModal();
    modal.classList.add('active');
  });

  btnClose.addEventListener('click', () => {
    modal.classList.remove('active');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });

  btnClear.addEventListener('click', () => {
    if (confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử đấu và danh sách câu sai trên localStorage không?')) {
      localStorage.removeItem(STORAGE_KEYS.HISTORY);
      localStorage.removeItem(STORAGE_KEYS.WRONG_QUESTIONS);
      localStorage.removeItem('gplx_chapter_stats');
      localStorage.removeItem('gplx_progress');
      Study.renderChip();
      renderHistoryModal();
    }
  });
}

function renderHistoryModal() {
  const history = JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) || '[]');
  const wrongMap = JSON.parse(localStorage.getItem(STORAGE_KEYS.WRONG_QUESTIONS) || '{}');

  const totalMatches = history.length;
  const passedMatches = history.filter(h => h.passed).length;
  const passRate = totalMatches > 0 ? Math.round((passedMatches / totalMatches) * 100) : 0;
  const avgScore = totalMatches > 0 ? (history.reduce((a, b) => a + b.score, 0) / totalMatches).toFixed(1) : '0.0';
  const wrongCount = Object.keys(wrongMap).length;

  document.getElementById('statTotalMatches').textContent = totalMatches;
  document.getElementById('statPassRate').textContent = `${passRate}%`;
  document.getElementById('statAvgScore').textContent = `${avgScore}/30`;
  document.getElementById('statWrongCount').textContent = wrongCount;

  // Render danh sách trận
  const historyList = document.getElementById('historyList');
  if (history.length === 0) {
    historyList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px;">Chưa có lịch sử trận đấu nào. Hãy chơi một trận nhé!</div>';
  } else {
    historyList.innerHTML = history.map(h => {
      const timeStr = `${Math.floor(h.submitTime / 60)}p${h.submitTime % 60}s`;
      return `
        <div class="history-item">
          <div class="history-meta">
            <span style="font-weight: 700; color: #f8fafc;">Phòng ${h.roomCode} · ${h.score}/30 điểm</span>
            <span style="font-size: 0.72rem; color: var(--text-muted);">
              ${h.date} · Làm trong ${timeStr} · ${h.answerChanges || 0} lần đổi đáp án
            </span>
          </div>
          <div>
            ${h.passed
              ? '<span class="badge-tag pass">ĐẠT B/B1</span>'
              : `<span class="badge-tag fail">${h.failedCritical ? 'RỚT (Liệt)' : 'KHÔNG ĐẠT'}</span>`
            }
          </div>
        </div>
      `;
    }).join('');
  }

  // Render danh sách câu sai
  const wrongListEl = document.getElementById('wrongQuestionsList');
  const wrongKeys = Object.keys(wrongMap);
  if (wrongKeys.length === 0) {
    wrongListEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 15px;">Chưa có câu sai nào! Chúc mừng bạn.</div>';
  } else {
    wrongListEl.innerHTML = wrongKeys.map(k => {
      const item = wrongMap[k];
      return `
        <span class="wrong-q-pill" title="${item.question}">
          Câu ${item.id} ${item.is_critical ? '⚠️' : ''} (sai ${item.wrongCount} lần)
        </span>
      `;
    }).join('');
  }
}

// ================= THEME ENGINE (LIGHT / DARK MODE) =================
const ThemeEngine = {
  theme: localStorage.getItem('gplx_theme') || 'dark',
  init() {
    this.apply(this.theme);
  },
  toggle() {
    this.apply(this.theme === 'dark' ? 'light' : 'dark');
  },
  apply(t) {
    this.theme = t;
    localStorage.setItem('gplx_theme', t);
    document.documentElement.setAttribute('data-theme', t);
    const isLight = t === 'light';
    const lBtn = document.getElementById('btnThemeToggleLobby');
    if (lBtn) lBtn.innerHTML = isLight ? '🌙 Tối' : '☀️ Sáng';
    const wBtn = document.getElementById('btnThemeToggleWaiting');
    if (wBtn) wBtn.innerHTML = isLight ? '🌙 Tối' : '☀️ Sáng';
    const gBtn = document.getElementById('btnThemeToggleGame');
    if (gBtn) gBtn.innerHTML = isLight ? '🌙' : '☀️';
  }
};
window.ThemeEngine = ThemeEngine;

// ================= SOUND & REACTION ENGINES =================
const SoundEngine = {
  ctx: null,
  enabled: localStorage.getItem('gplx_sound') !== 'false',
  init() {
    if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  },
  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('gplx_sound', this.enabled ? 'true' : 'false');
    const btn = document.getElementById('btnToggleSound');
    if (btn) btn.textContent = this.enabled ? '🔊' : '🔇';
  },
  beep(freq = 440, type = 'sine', duration = 0.08) {
    if (!this.enabled) return;
    try {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {}
  },
  playSelect() { this.beep(587.33, 'triangle', 0.06); },
  playNav() { this.beep(392.00, 'sine', 0.04); },
  playReaction() { this.beep(783.99, 'sine', 0.08); },
  playTick() { this.beep(880, 'sine', 0.03); },
  playCriticalAlert() {
    if (!this.enabled) return;
    [220, 180, 220, 180].forEach((f, i) => {
      setTimeout(() => this.beep(f, 'sawtooth', 0.15), i * 160);
    });
  },
  playCountdown(n) { this.beep(n === 1 ? 660 : 520, 'square', 0.12); },
  playGo() {
    [784, 988, 1175].forEach((f, i) => setTimeout(() => this.beep(f, 'triangle', 0.16), i * 90));
  },
  playChat() { this.beep(698, 'sine', 0.05); },
  playOvertake() {
    [523, 659, 880].forEach((f, i) => setTimeout(() => this.beep(f, 'triangle', 0.09), i * 70));
  },
  playVictory() {
    [523.25, 659.25, 783.99, 1046.50].forEach((f, i) => {
      setTimeout(() => this.beep(f, 'triangle', 0.2), i * 140);
    });
  }
};

function spawnFloatingEmoji(emoji, xPercent, yPercent) {
  const arena = document.getElementById('arenaContainer') || document.body;
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  const left = xPercent ? (xPercent * 100) : (20 + Math.random() * 60);
  const top = yPercent ? (yPercent * 100) : (65 + Math.random() * 20);
  el.style.left = `${left}%`;
  el.style.top = `${top}%`;
  arena.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function launchConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  if (!canvas) return;
  canvas.style.display = 'block';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const particles = Array.from({ length: 90 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    r: 4 + Math.random() * 6,
    d: 2 + Math.random() * 4,
    color: ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'][Math.floor(Math.random() * 6)],
    tilt: Math.random() * 10,
    tiltAngle: Math.random() * Math.PI,
    tiltAngleInc: 0.05 + Math.random() * 0.05
  }));
  let frames = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      ctx.beginPath();
      ctx.lineWidth = p.r;
      ctx.strokeStyle = p.color;
      ctx.moveTo(p.x + p.tilt + p.r / 2, p.y);
      ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 2);
      ctx.stroke();
      p.y += p.d;
      p.tiltAngle += p.tiltAngleInc;
      p.tilt = Math.sin(p.tiltAngle) * 12;
      if (p.y > canvas.height) p.y = -10;
    });
    frames++;
    if (frames < 200) {
      requestAnimationFrame(draw);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = 'none';
    }
  }
  draw();
}

// ================= HIỂN THỊ KẾT QUẢ & XEM LẠI CÂU HỎI TRỰC TIẾP =================
function showResultScreen(rankings, questions) {
  state.isReviewMode = true;
  state.hasSubmitted = true;
  state.rankings = rankings;
  state.exam30 = questions;

  rankings.forEach(r => {
    if (state.players[r.id]) {
      state.players[r.id].score = r.score;
      state.players[r.id].passed = r.passed;
      state.players[r.id].failedCritical = r.failedCritical;
      state.players[r.id].submitted = true;
      if (r.answers) state.players[r.id].answers = r.answers;
    }
  });

  // Ván đồng bộ / sinh tồn chỉ chơi N câu đầu của đề 30 câu: chỉ hiển thị N câu đó
  const total = Live.questionCount();
  questions = questions.slice(0, total);
  state.exam30 = questions;
  const allBtn = document.getElementById('grbAllBtn');
  if (allBtn) allBtn.textContent = `Tất cả (${total})`;
  const rfAll = document.getElementById('rfAllBtn');
  if (rfAll) rfAll.textContent = `Tất cả (${total} câu)`;

  const myRecord = rankings.find(p => p.id === state.myId) || {};
  const isPassed = !!myRecord.passed;
  const score = myRecord.score ?? 0;
  const failedCritical = !!myRecord.failedCritical;

  if (isPassed) {
    SoundEngine.playVictory();
    launchConfetti();
  }

  // 1. GIỮ NGUYÊN MÀN HÌNH ĐẤU TRƯỜNG CÂU HỎI QUEN THUỘC (Không chuyển trang xa lạ)
  showScreen(screenGame);

  // 2. Cập nhật trạng thái Nộp bài & Đồng hồ
  const timerText = document.getElementById('timerText');
  if (timerText) timerText.textContent = 'KẾT THÚC';
  const submitBtn = document.getElementById('btnSubmitExam');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Đã Nộp Bài ✅';
  }

  // 3. Hiển thị Banner kết quả trực quan ngay trên phần câu hỏi
  const banner = document.getElementById('gameResultBanner');
  if (banner) banner.style.display = 'flex';

  const scoreBadge = document.getElementById('grbScoreBadge');
  if (scoreBadge) {
    scoreBadge.textContent = `${score}/${total}`;
    scoreBadge.className = `grb-badge ${isPassed ? 'pass' : 'fail'}`;
  }

  const titleEl = document.getElementById('grbTitle');
  const subEl = document.getElementById('grbSub');

  if (isPassed) {
    if (titleEl) titleEl.textContent = `🎉 CHÚC MỪNG! BẠN ĐÃ ĐẠT KỲ THI SÁT HẠCH B/B1 (${score}/30)`;
    if (subEl) subEl.textContent = `Đạt xuất sắc · Không sai câu điểm liệt · Đáp án đúng và giải thích hiển thị trực tiếp ở câu bên dưới.`;
  } else if (failedCritical) {
    if (titleEl) titleEl.textContent = `❌ RẤT TIẾC! BẠN ĐÃ RỚT DO PHẠM CÂU ĐIỂM LIỆT (${score}/30)`;
    if (subEl) subEl.textContent = `Dù đạt ${score} điểm nhưng sai câu điểm liệt. Hãy đọc kỹ giải thích & luật bên dưới để rút kinh nghiệm!`;
  } else {
    if (titleEl) titleEl.textContent = `❌ CHƯA ĐẠT: BẠN ĐƯỢC ${score}/30 ĐIỂM (Cần tối thiểu 27/30)`;
    if (subEl) subEl.textContent = `Hãy bấm vào các câu màu đỏ ở danh sách 30 câu bên phải để ôn tập lại!`;
  }

  // Đếm số câu làm sai & câu điểm liệt
  let wrongCount = 0;
  let critCount = 0;
  questions.slice(0, Live.questionCount()).forEach((q, idx) => {
    const isCorrect = (state.myAnswers[idx] === q.correct_option);
    if (!isCorrect) {
      wrongCount++;
      if (q.is_critical) critCount++;
    }
  });

  const wrongCountEl = document.getElementById('grbWrongCount');
  if (wrongCountEl) wrongCountEl.textContent = wrongCount;
  const critCountEl = document.getElementById('grbCritCount');
  if (critCountEl) critCountEl.textContent = critCount;

  // 4. Cập nhật Bục Podium trong Modal
  renderPodiumModal(rankings);

  // 5. Nạp ngay câu hỏi làm sai đầu tiên (hoặc câu 1 nếu đúng hết) trực tiếp lên phần câu hỏi
  let firstWrongIdx = questions.slice(0, Live.questionCount()).findIndex((q, idx) => state.myAnswers[idx] !== q.correct_option);
  const targetIdx = firstWrongIdx !== -1 ? firstWrongIdx : 0;
  renderQuestion(targetIdx);

  // 6. Cập nhật toàn bộ 30 nút Palette sang màu Xanh/Đỏ/Liệt
  updatePaletteGrid();

  // Đồng thời chuẩn bị sẵn dữ liệu cho màn hình kết quả phụ (nếu cần xem toàn bộ 30 câu cùng lúc)
  renderLegacyReviewCards(rankings, questions, myRecord);
  Live.decorateResult(rankings);
  Live.updateRace();
}

function renderPodiumModal(rankings) {
  const modalBox = document.getElementById('modalPodiumBox');
  const crowns = ['🥇 VÔ ĐỊCH', '🥈 HẠNG NHÌ', '🥉 HẠNG BA'];

  const html = rankings.slice(0, 3).map((p, idx) => `
    <div class="podium-slot rank-${idx + 1}">
      <div class="podium-crown">${crowns[idx]}</div>
      <div style="font-size: 2rem; margin: 4px 0;">${p.avatar}</div>
      <div class="podium-name">${esc(p.name)}</div>
      <div class="podium-score">${p.livePts !== undefined ? `${p.livePts} điểm` : `${p.score} / 30`}</div>
      <div style="margin-top: 8px;">
        ${p.livePts !== undefined
          ? `<span class="badge-tag pass">⚡ Đúng ${Math.min(p.score, Live.total)} câu</span>`
          : (p.passed
            ? '<span class="badge-tag pass">🎉 ĐẠT B/B1</span>'
            : `<span class="badge-tag fail">${p.failedCritical ? '⚠️ RỚT (Sai liệt)' : '❌ KHÔNG ĐẠT'}</span>`)
        }
      </div>
      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 6px;">
        Thời gian: ${Math.floor((p.submitTime || 0) / 60)}p${(p.submitTime || 0) % 60}s
      </div>
    </div>
  `).join('');

  if (modalBox) modalBox.innerHTML = html;
  const screenPodium = document.getElementById('podiumBox');
  if (screenPodium) screenPodium.innerHTML = html;
}

function renderLegacyReviewCards(rankings, questions, myRecord) {
  const cardsListEl = document.getElementById('reviewCardsList');
  if (!cardsListEl) return;

  cardsListEl.innerHTML = questions.map((q, idx) => {
    const qNum = idx + 1;
    const myChoice = myRecord ? myRecord.answers?.[idx] : undefined;
    const isMyCorrect = (myChoice === q.correct_option);
    const isCritical = q.is_critical;

    const optionsHtml = q.options.map((optText, optIdx) => {
      const optNum = optIdx + 1;
      const isCorrectOption = (optNum === q.correct_option);
      const playersPicked = rankings.filter(p => p.answers?.[idx] === optNum);

      return `
        <div class="option-card review ${isCorrectOption ? 'correct-answer' : ''}">
          <span class="opt-num" style="${isCorrectOption ? 'background: #10b981; color: white;' : ''}">${optNum}</span>
          <span class="opt-text">${optText}</span>
          ${isCorrectOption ? '<span class="correct-badge-pill">✓ ĐÁP ÁN ĐÚNG</span>' : ''}
          <div class="opt-opponents-tag">
            ${playersPicked.map(p => {
              const isPRight = (optNum === q.correct_option);
              return `
                <span class="op-choice-badge ${isPRight ? '' : 'wrong-pick'}" style="background: ${p.color};">
                  ${p.avatar} ${esc(p.name)} ${isPRight ? '✓' : '✗'}
                  ${isCritical && !isPRight ? ' (Liệt)' : ''}
                </span>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="review-q-card ${isCritical ? 'critical' : ''} ${isMyCorrect ? 'user-correct' : 'user-wrong'}" id="review-card-${idx}" data-critical="${isCritical}" data-wrong="${!isMyCorrect}">
        <div class="q-badge-bar">
          <span class="q-index-pill">Câu ${qNum} / 30</span>
          <span class="q-chapter-pill">Chương ${q.chapter}: ${q.chapter_name || ''}</span>
          ${isCritical ? '<span class="q-critical-pill">⚠️ CÂU ĐIỂM LIỆT</span>' : ''}
          <span style="margin-left: auto; font-size: 0.85rem; font-weight: 700; color: ${isMyCorrect ? 'var(--success)' : 'var(--danger)'};">
            ${isMyCorrect ? '✓ BẠN TRẢ LỜI ĐÚNG' : '✗ BẠN TRẢ LỜI SAI'}
          </span>
        </div>

        <div class="q-text-content">${q.question}</div>

        ${q.image ? `
          <div class="q-image-box">
            <img src="./${q.image}" alt="Hình minh họa câu ${qNum}">
          </div>
        ` : ''}

        <div class="options-container review-mode">
          ${optionsHtml}
        </div>

        ${q.explanation ? `
          <div class="explanation-box" style="margin-top: 12px;">
            <div class="explanation-title">💡 Giải thích & Căn cứ pháp lý:</div>
            <div>${q.explanation}</div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// Khởi động
document.addEventListener('DOMContentLoaded', initApp);
