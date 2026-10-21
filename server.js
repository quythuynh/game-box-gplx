const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Load 600 questions dataset
const questionsData = require('./data/questions_600_bca.json');
console.log(`📚 Đã nạp thành công ${questionsData.length} câu hỏi từ bộ dữ liệu Bộ Công An.`);

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));
app.get('/healthz', (req, res) => res.send('ok'));

// Preset player colors
const PLAYER_COLORS = [
  '#3b82f6', // Xanh dương
  '#ef4444', // Đỏ
  '#10b981', // Xanh lá
  '#f59e0b', // Vàng cam
  '#8b5cf6', // Tím
  '#ec4899', // Hồng
];

// Helper: generate 4-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Helper: pick 30 questions according to official distribution
function generate30Questions(mode = 'standard') {
  if (mode === 'critical') {
    // 30 questions randomly picked from 60 critical questions
    const criticalList = questionsData.filter(q => q.is_critical);
    const shuffled = [...criticalList].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 30);
  }

  if (mode === 'signs') {
    // 30 câu chuyên Sa hình & Biển báo (Chương 5 & 6)
    const signsList = questionsData.filter(q => q.chapter === 5 || q.chapter === 6);
    const shuffled = [...signsList].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 30);
  }

  // Standard B/B1 distribution:
  // 30 questions total:
  // - 1-2 critical questions guaranteed
  // - Ch 1 (Quy tắc): 9 questions
  // - Ch 2 (Đạo đức): 1 question
  // - Ch 3 (Kỹ thuật): 3 questions
  // - Ch 4 (Cấu tạo): 2 questions
  // - Ch 5 (Biển báo): 9 questions
  // - Ch 6 (Sa hình): 6 questions
  const ch = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  questionsData.forEach(q => {
    if (ch[q.chapter]) ch[q.chapter].push(q);
  });

  function sample(arr, n) {
    const shuffled = [...arr].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, n);
  }

  const criticalAll = questionsData.filter(q => q.is_critical);
  const pickedCritical = sample(criticalAll, 2);
  const pickedIds = new Set(pickedCritical.map(q => q.id));

  const plan = { 1: 9, 2: 1, 3: 3, 4: 2, 5: 9, 6: 6 };
  let exam = [...pickedCritical];

  for (let c = 1; c <= 6; c++) {
    const currentInChapter = exam.filter(q => q.chapter === c).length;
    const needed = Math.max(0, plan[c] - currentInChapter);
    const available = ch[c].filter(q => !pickedIds.has(q.id));
    const chosen = sample(available, needed);
    chosen.forEach(q => {
      pickedIds.add(q.id);
      exam.push(q);
    });
  }

  exam.sort((a, b) => a.id - b.id);
  return exam.slice(0, 30);
}

// In-memory rooms
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoomCode = null;

  // 1. Create Room
  socket.on('create-room', ({ name, avatar, mode = 'standard', timeLimit = 1200 }, callback) => {
    let roomCode = generateRoomCode();
    while (rooms.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    const color = PLAYER_COLORS[0];
    const room = {
      code: roomCode,
      hostId: socket.id,
      status: 'lobby', // 'lobby' | 'playing' | 'ended'
      mode: mode,
      timeLimit: parseInt(timeLimit, 10) || 1200,
      startedAt: null,
      endedAt: null,
      questions: [],
      players: {
        [socket.id]: {
          id: socket.id,
          name: name ? name.trim().slice(0, 20) : 'Người chơi 1',
          avatar: avatar || '🏎️',
          color: color,
          isHost: true,
          isReady: true,
          currentQ: 0,
          answers: {},
          submitted: false,
          submitTime: null,
          score: 0,
          passed: false,
          failedCritical: false,
        }
      }
    };

    rooms.set(roomCode, room);
    currentRoomCode = roomCode;
    socket.join(roomCode);

    if (callback) {
      callback({ success: true, roomCode, player: room.players[socket.id] });
    }

    io.to(roomCode).emit('room-state', getPublicRoomState(room));
    console.log(`🎮 Phòng ${roomCode} được tạo bởi [${room.players[socket.id].name}]`);
  });

  // 2. Join Room
  socket.on('join-room', ({ roomCode, name, avatar }, callback) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      return callback({ success: false, message: 'Phòng không tồn tại!' });
    }

    const playerCount = Object.keys(room.players).length;
    if (playerCount >= 4) {
      return callback({ success: false, message: 'Phòng đã đầy (tối đa 4 người)!' });
    }

    if (room.status === 'playing') {
      return callback({ success: false, message: 'Trận đấu đang diễn ra, không thể tham gia!' });
    }

    const color = PLAYER_COLORS[playerCount % PLAYER_COLORS.length];
    room.players[socket.id] = {
      id: socket.id,
      name: name ? name.trim().slice(0, 20) : `Người chơi ${playerCount + 1}`,
      avatar: avatar || ['🚗', '🚙', '🚕', '🏎️'][playerCount % 4],
      color: color,
      isHost: false,
      isReady: false,
      currentQ: 0,
      answers: {},
      submitted: false,
      submitTime: null,
      score: 0,
      passed: false,
      failedCritical: false,
    };

    currentRoomCode = code;
    socket.join(code);

    if (callback) {
      callback({ success: true, roomCode: code, player: room.players[socket.id] });
    }

    io.to(code).emit('room-state', getPublicRoomState(room));
    console.log(`👋 [${room.players[socket.id].name}] đã tham gia phòng ${code}`);
  });

  // 3. Toggle Ready
  socket.on('toggle-ready', ({ isReady }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.players[socket.id]) return;

    room.players[socket.id].isReady = Boolean(isReady);
    io.to(currentRoomCode).emit('room-state', getPublicRoomState(room));
  });

  // 4. Change game settings (Host only)
  socket.on('update-settings', ({ mode, timeLimit }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;

    if (mode) room.mode = mode;
    if (timeLimit) room.timeLimit = parseInt(timeLimit, 10);

    io.to(currentRoomCode).emit('room-state', getPublicRoomState(room));
  });

  // 5. Start Game (Host only)
  socket.on('start-game', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;

    room.questions = generate30Questions(room.mode);
    room.status = 'playing';
    room.startedAt = Date.now();

    // Reset player answers
    Object.values(room.players).forEach(p => {
      p.answers = {};
      p.currentQ = 0;
      p.submitted = false;
      p.score = 0;
      p.submitTime = null;
    });

    console.log(`🏁 Phòng ${currentRoomCode} BẮT ĐẦU chơi! Sinh 30 câu hỏi.`);
    io.to(currentRoomCode).emit('game-started', {
      room: getPublicRoomState(room),
      questions: room.questions.map(q => ({
        id: q.id,
        chapter: q.chapter,
        chapter_name: q.chapter_name,
        question: q.question,
        image: q.image,
        options: q.options,
        is_critical: q.is_critical,
        // Giữ lại correct_option cho việc hiển thị hoặc chấm điểm
        correct_option: q.correct_option,
        explanation: q.explanation
      }))
    });
  });

  // 6. Realtime Mouse Cursor Movement
  socket.on('cursor-move', ({ xPercent, yPercent, qIndex }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'playing') return;

    const player = room.players[socket.id];
    if (!player) return;

    socket.to(currentRoomCode).emit('player-cursor', {
      playerId: socket.id,
      name: player.name,
      avatar: player.avatar,
      color: player.color,
      x: xPercent,
      y: yPercent,
      qIndex: qIndex
    });
  });

  // 7. Realtime Answer Selection
  socket.on('select-answer', ({ qIndex, optionIndex }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'playing') return;

    const player = room.players[socket.id];
    if (!player || player.submitted) return;

    player.answers[qIndex] = optionIndex;
    const answeredCount = Object.keys(player.answers).length;
    const answeredList = Object.keys(player.answers).map(Number);

    // BẢO MẬT & TRÁNH NHÌN BÀI: Chỉ gửi thông báo người chơi đã làm câu qIndex và tổng số câu xong.
    // KHÔNG gửi optionIndex (che ẩn đáp án đã chọn trong lúc thi).
    socket.to(currentRoomCode).emit('player-progress-updated', {
      playerId: socket.id,
      name: player.name,
      color: player.color,
      qIndex: qIndex,
      totalAnswered: answeredCount,
      answeredList: answeredList
    });
  });

  // 8. Realtime Question Navigation (which question player is currently on)
  socket.on('navigate-question', ({ qIndex }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'playing') return;

    const player = room.players[socket.id];
    if (!player) return;

    player.currentQ = qIndex;
    socket.to(currentRoomCode).emit('player-navigated', {
      playerId: socket.id,
      qIndex: qIndex
    });
  });

  // 8.1 Realtime Emoji Reaction
  socket.on('send-reaction', ({ emoji }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    io.to(currentRoomCode).emit('player-reaction', {
      playerId: socket.id,
      name: player.name,
      avatar: player.avatar,
      color: player.color,
      emoji: emoji
    });
  });

  // 9. Submit Exam
  socket.on('submit-exam', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'playing') return;

    const player = room.players[socket.id];
    if (!player || player.submitted) return;

    player.submitted = true;
    player.submitTime = Math.round((Date.now() - room.startedAt) / 1000);

    // Calculate score
    let score = 0;
    let failedCritical = false;

    room.questions.forEach((q, idx) => {
      const chosen = player.answers[idx];
      if (chosen === q.correct_option) {
        score++;
      } else if (q.is_critical && chosen !== undefined) {
        failedCritical = true;
      }
    });

    // Điểm đạt: >= 27/30 và KHÔNG sai câu điểm liệt
    const passed = (score >= 27) && !failedCritical;
    player.score = score;
    player.passed = passed;
    player.failedCritical = failedCritical;

    io.to(currentRoomCode).emit('player-submitted', {
      playerId: socket.id,
      name: player.name,
      score: score,
      passed: passed,
      failedCritical: failedCritical,
      submitTime: player.submitTime,
      answers: player.answers
    });

    // Check if all players have submitted
    const allSubmitted = Object.values(room.players).every(p => p.submitted);
    if (allSubmitted) {
      finishGame(room);
    }
  });

  // 10. Restart Game (Host only)
  socket.on('restart-game', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id) return;

    room.status = 'lobby';
    room.questions = [];
    room.startedAt = null;
    room.endedAt = null;

    Object.values(room.players).forEach(p => {
      p.answers = {};
      p.currentQ = 0;
      p.submitted = false;
      p.score = 0;
      p.submitTime = null;
      p.passed = false;
      p.failedCritical = false;
    });

    io.to(currentRoomCode).emit('room-restarted', getPublicRoomState(room));
  });

  // 11. Disconnect
  socket.on('disconnect', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const leavingPlayer = room.players[socket.id];
    delete room.players[socket.id];

    // Remove cursor of leaving player
    socket.to(currentRoomCode).emit('player-left', {
      playerId: socket.id,
      name: leavingPlayer ? leavingPlayer.name : 'Người chơi'
    });

    const remainingPlayerIds = Object.keys(room.players);
    if (remainingPlayerIds.length === 0) {
      // Clean up empty room
      rooms.delete(currentRoomCode);
      console.log(`🗑️ Phòng ${currentRoomCode} đã bị xoá (không còn ai).`);
    } else {
      // Reassign host if needed
      if (room.hostId === socket.id) {
        room.hostId = remainingPlayerIds[0];
        room.players[room.hostId].isHost = true;
      }
      io.to(currentRoomCode).emit('room-state', getPublicRoomState(room));
      // Người rời đi là người cuối chưa nộp bài -> kết thúc trận
      if (room.status === 'playing' && remainingPlayerIds.every(id => room.players[id].submitted)) {
        finishGame(room);
      }
    }
  });
});

function finishGame(room) {
  room.status = 'ended';
  room.endedAt = Date.now();

  // Sort leaderboard
  const rankings = Object.values(room.players)
    .sort((a, b) => {
      // Ưu tiên đậu > rớt, sau đó điểm cao hơn, sau đó thời gian làm bài nhanh hơn
      if (a.passed !== b.passed) return a.passed ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return (a.submitTime || 9999) - (b.submitTime || 9999);
    });

  io.to(room.code).emit('game-ended', {
    rankings: rankings,
    room: getPublicRoomState(room),
    questions: room.questions
  });
  console.log(`🏆 Phòng ${room.code} kết thúc trận đấu.`);
}

function getPublicRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    mode: room.mode,
    timeLimit: room.timeLimit,
    startedAt: room.startedAt,
    players: room.players
  };
}

server.listen(PORT, () => {
  console.log(`\n============================================================`);
  console.log(`🚀 MULTIPLAYER QUIZ SERVER ĐANG CHẠY TẠI: http://localhost:${PORT}`);
  console.log(`👥 Hỗ trợ 2-4 người chơi realtime: chuột, chọn đáp án, bảng xếp hạng.`);
  console.log(`============================================================\n`);
});
