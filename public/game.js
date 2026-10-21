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

// ================= DOM ELEMENTS =================
const screenLobby = document.getElementById('screenLobby');
const screenWaiting = document.getElementById('screenWaiting');
const screenGame = document.getElementById('screenGame');
const screenResult = document.getElementById('screenResult');

// ================= INITIALIZE =================
function initApp() {
  loadProfileFromStorage();

  // Kết nối Socket.io
  const socket = io(window.GAME_SERVER_URL || undefined, {
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    timeout: 8000
  });
  state.socket = socket;

  socket.on('connect_error', () => {
    const onVercel = /\.vercel\.app$/.test(location.hostname) && !window.GAME_SERVER_URL;
    showLobbyError(onVercel
      ? 'Vercel không chạy được Socket.io server. Hãy deploy server.js (Render/Railway...) và đặt GAME_SERVER_URL trong config.js.'
      : 'Không kết nối được server realtime!');
    resetLobbyButtons();
  });

  socket.on('connect', () => {
    state.myId = socket.id;
    console.log('⚡ Đã kết nối Socket.io Realtime. ID:', socket.id);
  });

  socket.on('disconnect', () => {
    console.warn('⚠️ Mất kết nối đến server.');
  });

  // Lắng nghe cập nhật phòng
  socket.on('room-state', (room) => {
    state.roomCode = room.code;
    state.players = room.players;
    state.gameMode = room.mode;
    state.timeLimit = room.timeLimit;
    state.isHost = (room.hostId === socket.id);

    document.getElementById('displayRoomCode').textContent = room.code;
    renderWaitingList();

    if (room.status === 'lobby' && !screenGame.classList.contains('active')) {
      showScreen(screenWaiting);
    }
  });

  // Trận đấu bắt đầu
  socket.on('game-started', ({ room, questions }) => {
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

  // Đối thủ chọn đáp án (CHỈ NHẬN TIẾN ĐỘ, KHÔNG NHẬN ĐÁP ÁN CỤ THỂ ĐỂ TRÁNH NHÌN BÀI)
  socket.on('player-progress-updated', (data) => {
    if (state.players[data.playerId]) {
      state.players[data.playerId].answeredList = data.answeredList;
      state.players[data.playerId].totalAnswered = data.totalAnswered;
    }
    updateOpponentsBar();
    updatePaletteGrid();
  });

  // Đối thủ chuyển câu
  socket.on('player-navigated', (data) => {
    if (state.players[data.playerId]) {
      state.players[data.playerId].currentQ = data.qIndex;
    }
    updateOpponentsBar();
  });

  // Người chơi nộp bài
  socket.on('player-submitted', (data) => {
    if (state.players[data.playerId]) {
      state.players[data.playerId].submitted = true;
      state.players[data.playerId].score = data.score;
      state.players[data.playerId].answers = data.answers;
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
    saveMatchResultToStorage(rankings, questions);
    showResultScreen(rankings, questions);
  });

  // Người chơi thoát phòng
  socket.on('player-left', ({ playerId, name }) => {
    delete state.players[playerId];
    removeRemoteCursor(playerId);
    renderWaitingList();
    updateOpponentsBar();
  });

  // Phòng restart ván mới
  socket.on('room-restarted', (room) => {
    state.isReviewMode = false;
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
  const name = nameInput.value.trim() || 'Tay Lái Cừ Khôi';
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

  // Bấm Tạo Phòng
  document.getElementById('btnCreateRoom').addEventListener('click', () => {
    const { name, avatar } = getMyProfile();
    const mode = document.getElementById('gameModeSelect').value;
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
        document.getElementById('displayRoomCode').textContent = res.roomCode;
        showScreen(screenWaiting);
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

  // Nút mở tab mới test ngay lập tức
  document.getElementById('btnOpenTestTab').addEventListener('click', () => {
    const testUrl = `${window.location.origin}${window.location.pathname}?room=${state.roomCode}&auto=true`;
    window.open(testUrl, '_blank');
  });

  // Rời phòng
  document.getElementById('btnLeaveRoom').addEventListener('click', () => {
    window.location.reload();
  });

  // Bắt đầu game (Host)
  document.getElementById('btnStartGame').addEventListener('click', () => {
    if (state.isHost) {
      state.socket.emit('start-game');
    }
  });

  // Về sảnh chính từ màn hình kết quả
  document.getElementById('btnBackToLobby').addEventListener('click', () => {
    window.location.reload();
  });
}

function renderWaitingList() {
  const listEl = document.getElementById('waitingPlayersList');
  const players = Object.values(state.players);

  listEl.innerHTML = players.map(p => `
    <div class="player-item">
      <div class="player-info">
        <div class="player-avatar" style="border: 2px solid ${p.color};">${p.avatar}</div>
        <div>
          <span class="player-name">${p.name} ${p.id === state.myId ? '(Bạn)' : ''}</span>
          ${p.isHost ? '<span class="player-tag">👑 Trưởng phòng</span>' : ''}
        </div>
      </div>
      <span class="status-badge ready">● Sẵn sàng</span>
    </div>
  `).join('');

  const btnStart = document.getElementById('btnStartGame');
  if (state.isHost) {
    btnStart.style.display = 'block';
    btnStart.textContent = `🏁 Bắt Đầu Thi Đấu (${players.length} người)`;
  } else {
    btnStart.style.display = 'none';
  }
}

// ================= GAMEPLAY =================
function startExamUI() {
  state.currentQIndex = 0;
  state.myAnswers = {};
  state.isReviewMode = false;
  state.rankings = [];

  const banner = document.getElementById('gameResultBanner');
  if (banner) banner.style.display = 'none';
  const subBtn = document.getElementById('btnSubmitExam');
  if (subBtn) {
    subBtn.disabled = false;
    subBtn.textContent = 'Nộp Bài 📝';
  }

  showScreen(screenGame);

  renderPaletteGrid();
  renderQuestion(state.currentQIndex);
  updateOpponentsBar();
  startTimer();
}

function startTimer() {
  clearInterval(state.timerInterval);
  state.timeRemaining = state.timeLimit;
  updateTimerDisplay();

  state.timerInterval = setInterval(() => {
    state.timeRemaining--;
    updateTimerDisplay();

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

  if (state.timeRemaining <= 60) {
    document.getElementById('gameTimer').style.borderColor = 'var(--danger)';
    document.getElementById('timerText').style.color = '#f87171';
  }
}

function renderQuestion(index) {
  if (!state.exam30 || !state.exam30[index]) return;

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

  const q = state.exam30[index];
  document.getElementById('qBadgeNum').textContent = `Câu ${index + 1} / 30`;
  document.getElementById('qBadgeChapter').textContent = `Chương ${q.chapter}: ${q.chapter_name || ''}`;

  const critBadge = document.getElementById('qBadgeCritical');
  critBadge.style.display = q.is_critical ? 'inline-block' : 'none';

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
  const isRevealed = state.isReviewMode || (state.instantFeedback && mySelected !== undefined);

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
          ${p.avatar} ${p.name} ${isCorrectOption ? '✓' : '✗'}
        </span>
      `).join('');
    }

    return `
      <div class="${cardCls}" data-opt="${optNum}">
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

  if (!state.isReviewMode) {
    optionsContainer.querySelectorAll('.option-card').forEach(card => {
      card.addEventListener('click', () => {
        const optNum = parseInt(card.dataset.opt, 10);
        selectMyAnswer(index, optNum);
      });
    });
  }

  // Trong lúc làm bài: Ẩn các đáp án của người khác để chống nhìn bài!
  // Chỉ biết người đó đang ở câu nào và đã hoàn thành những câu nào.

  document.getElementById('btnPrevQ').disabled = index <= 0;
  document.getElementById('btnNextQ').disabled = index >= 29;

  updatePaletteCurrent(index);

  // Gửi vị trí câu đang xem
  state.socket.emit('navigate-question', { qIndex: index });
}

function selectMyAnswer(qIndex, optionIndex) {
  if (state.isReviewMode) return;

  SoundEngine.playSelect();

  // Ghi nhận hành vi đổi ý chọn đáp án khác
  if (state.myAnswers[qIndex] !== undefined && state.myAnswers[qIndex] !== optionIndex) {
    state.behavior.answerChangesCount++;
  }

  state.myAnswers[qIndex] = optionIndex;

  renderQuestion(qIndex);
  updatePaletteGrid();

  // Phát tín hiệu Realtime cho tất cả người chơi
  state.socket.emit('select-answer', {
    qIndex: qIndex,
    optionIndex: optionIndex
  });
}

function updateOpponentsBar() {
  const bar = document.getElementById('liveOpponentsBar');
  const players = Object.values(state.players);

  bar.innerHTML = players.map(p => {
    const isMe = p.id === state.myId;
    const answeredCount = isMe 
      ? Object.keys(state.myAnswers).length 
      : (p.totalAnswered ?? p.answeredList?.length ?? Object.keys(p.answers || {}).length);
    const pct = Math.round((answeredCount / 30) * 100);

    return `
      <div class="opponent-card ${isMe ? 'me' : ''}">
        <span class="op-avatar">${p.avatar}</span>
        <div class="op-meta">
          <div class="op-name">
            <span class="op-color-dot" style="background: ${p.color};"></span>
            <span>${p.name}</span>
          </div>
          <div class="op-progress-txt">
            ${answeredCount}/30 câu · Đang xem: C${(p.currentQ ?? 0) + 1}
          </div>
          <div class="op-progress-bar">
            <div class="op-progress-fill" style="width: ${pct}%; background: ${p.color};"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

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
        badge.innerHTML = `${p.avatar} ${p.name}`;
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
        <div class="pallet-dots-wrap" id="palletDots-${i}"></div>
      </button>
    `;
  }

  grid.innerHTML = html;

  grid.querySelectorAll('.q-pallet-btn').forEach(btn => {
    btn.addEventListener('click', () => {
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
            return `<span class="pallet-dot" style="background: ${pRight ? '#10b981' : '#ef4444'};" title="${p.name}: ${pRight ? 'Đúng' : 'Sai'}"></span>`;
          }).join('');
      }
    }
    return;
  }

  // Chế độ đang thi đấu bình thường
  for (let i = 0; i < 30; i++) {
    const btn = document.getElementById(`palletBtn-${i}`);
    const dotsWrap = document.getElementById(`palletDots-${i}`);
    if (!btn || !dotsWrap) continue;

    const myAnswered = state.myAnswers[i] !== undefined;
    btn.classList.toggle('my-answered', myAnswered);

    // Chấm màu của những người chơi khác đã làm xong câu này
    dotsWrap.innerHTML = players
      .filter(p => {
        if (p.id === state.myId) return false;
        return (p.answeredList && p.answeredList.includes(i)) || (p.answers && p.answers[i] !== undefined);
      })
      .map(p => `<span class="pallet-dot" style="background: ${p.color};" title="${p.name} đã làm câu này"></span>`)
      .join('');
  }
}

// ================= REALTIME MOUSE CURSOR =================
function setupGameEvents() {
  const arena = document.getElementById('arenaContainer');

  arena.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - state.lastCursorSend < 35) return;
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
    if (state.currentQIndex > 0) {
      renderQuestion(state.currentQIndex - 1);
    }
  });

  document.getElementById('btnNextQ').addEventListener('click', () => {
    if (state.currentQIndex < 29) {
      renderQuestion(state.currentQIndex + 1);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!screenGame.classList.contains('active')) return;

    if (e.key === 'ArrowLeft' && state.currentQIndex > 0) {
      renderQuestion(state.currentQIndex - 1);
    } else if (e.key === 'ArrowRight' && state.currentQIndex < 29) {
      renderQuestion(state.currentQIndex + 1);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      const optNum = parseInt(e.key, 10);
      const currentQuestion = state.exam30[state.currentQIndex];
      if (currentQuestion && optNum <= currentQuestion.options.length) {
        selectMyAnswer(state.currentQIndex, optNum);
      }
    }
  });

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

  // Thả cảm xúc Realtime
  document.querySelectorAll('.qr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      SoundEngine.playReaction();
      spawnFloatingEmoji(emoji);
      state.socket.emit('send-reaction', { emoji });
    });
  });

  document.getElementById('btnPlayAgain').addEventListener('click', () => {
    if (state.isHost) {
      state.socket.emit('restart-game');
    } else {
      alert('Vui lòng đợi chủ phòng bắt đầu lại ván mới!');
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
        const firstWrong = state.exam30.findIndex((q, i) => state.myAnswers[i] !== q.correct_option);
        if (firstWrong !== -1) {
          renderQuestion(firstWrong);
        } else {
          alert('Tuyệt vời! Bạn không làm sai câu nào.');
        }
      } else if (filter === 'critical') {
        const firstCrit = state.exam30.findIndex((q) => q.is_critical);
        if (firstCrit !== -1) renderQuestion(firstCrit);
      } else {
        renderQuestion(0);
      }
    });
  });

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
      if (state.isHost) {
        state.socket.emit('restart-game');
      } else {
        alert('Vui lòng đợi chủ phòng bắt đầu lại ván mới!');
      }
    });
  }

  const btnModalPlayAgain = document.getElementById('btnModalPlayAgain');
  if (btnModalPlayAgain) {
    btnModalPlayAgain.addEventListener('click', () => {
      document.getElementById('podiumModal').classList.remove('active');
      if (state.isHost) {
        state.socket.emit('restart-game');
      } else {
        alert('Vui lòng đợi chủ phòng bắt đầu lại ván mới!');
      }
    });
  }

  const btnBannerLobby = document.getElementById('btnBannerLobby');
  if (btnBannerLobby) {
    btnBannerLobby.addEventListener('click', () => {
      window.location.reload();
    });
  }
}

function renderRemoteCursor(playerId, name, avatar, color, xPercent, yPercent, qIndex) {
  if (playerId === state.myId) return;

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

  cursorEl.style.left = `${xPercent * 100}%`;
  cursorEl.style.top = `${yPercent * 100}%`;
}

function removeRemoteCursor(playerId) {
  const el = document.getElementById(`cursor-${playerId}`);
  if (el) el.remove();
}

function handleSubmitExam() {
  clearInterval(state.timerInterval);
  document.getElementById('btnSubmitExam').disabled = true;
  document.getElementById('btnSubmitExam').textContent = 'Đã nộp bài ✅';

  state.socket.emit('submit-exam');
}

// ================= LOCALSTORAGE: SAVE MATCH RESULT & WRONG QUESTIONS =================
function saveMatchResultToStorage(rankings, questions) {
  const myRecord = rankings.find(p => p.id === state.myId);
  if (!myRecord) return;

  try {
    // 1. Lưu vào danh sách lịch sử trận đấu
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
    history.unshift(newEntry);
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history.slice(0, 30))); // Lưu tối đa 30 trận gần nhất

    // 2. Lưu các câu làm sai để người dùng ôn lại
    const wrongMap = JSON.parse(localStorage.getItem(STORAGE_KEYS.WRONG_QUESTIONS) || '{}');
    questions.forEach((q, idx) => {
      const myChoice = state.myAnswers[idx];
      if (myChoice !== q.correct_option) {
        wrongMap[q.id] = {
          id: q.id,
          question: q.question.slice(0, 80) + '...',
          is_critical: q.is_critical,
          wrongCount: (wrongMap[q.id]?.wrongCount || 0) + 1,
        };
      }
    });
    localStorage.setItem(STORAGE_KEYS.WRONG_QUESTIONS, JSON.stringify(wrongMap));

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
  state.rankings = rankings;
  state.exam30 = questions;

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
    scoreBadge.textContent = `${score}/30`;
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
  questions.forEach((q, idx) => {
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
  let firstWrongIdx = questions.findIndex((q, idx) => state.myAnswers[idx] !== q.correct_option);
  const targetIdx = firstWrongIdx !== -1 ? firstWrongIdx : 0;
  renderQuestion(targetIdx);

  // 6. Cập nhật toàn bộ 30 nút Palette sang màu Xanh/Đỏ/Liệt
  updatePaletteGrid();

  // Đồng thời chuẩn bị sẵn dữ liệu cho màn hình kết quả phụ (nếu cần xem toàn bộ 30 câu cùng lúc)
  renderLegacyReviewCards(rankings, questions, myRecord);
}

function renderPodiumModal(rankings) {
  const modalBox = document.getElementById('modalPodiumBox');
  const crowns = ['🥇 VÔ ĐỊCH', '🥈 HẠNG NHÌ', '🥉 HẠNG BA'];

  const html = rankings.slice(0, 3).map((p, idx) => `
    <div class="podium-slot rank-${idx + 1}">
      <div class="podium-crown">${crowns[idx]}</div>
      <div style="font-size: 2rem; margin: 4px 0;">${p.avatar}</div>
      <div class="podium-name">${p.name}</div>
      <div class="podium-score">${p.score} / 30</div>
      <div style="margin-top: 8px;">
        ${p.passed 
          ? '<span class="badge-tag pass">🎉 ĐẠT B/B1</span>' 
          : `<span class="badge-tag fail">${p.failedCritical ? '⚠️ RỚT (Sai liệt)' : '❌ KHÔNG ĐẠT'}</span>`
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
                  ${p.avatar} ${p.name} ${isPRight ? '✓' : '✗'}
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
