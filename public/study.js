/**
 * Ôn tập & tiến độ cá nhân (toàn bộ lưu trong localStorage):
 * - Thống kê độ chính xác theo chương, gợi ý chương yếu nhất
 * - Lặp lại ngắt quãng (Leitner 1 - 3 - 7 ngày) cho các câu làm sai
 * - Chuỗi ngày luyện, mục tiêu hằng ngày, XP / cấp, huy hiệu
 * - Duyệt và tra cứu 600 câu (không phân biệt dấu)
 */
const Study = (() => {
  const $ = id => document.getElementById(id);
  const KEYS = {
    WRONG: 'gplx_wrong_questions',
    CHAPTERS: 'gplx_chapter_stats',
    PROGRESS: 'gplx_progress'
  };
  const DAY = 24 * 3600 * 1000;
  const INTERVALS = [1 * DAY, 3 * DAY, 7 * DAY]; // hộp 0 -> 1 ngày, hộp 1 -> 3 ngày, hộp 2 -> 7 ngày; đúng thêm lần nữa là thuộc
  const DAILY_GOAL = 30;
  const PAGE = 30;

  let questions = null;
  let normIndex = null;
  let searchResults = [];
  let shown = 0;

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  const dayKey = (t = Date.now()) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function loadProgress() {
    const p = read(KEYS.PROGRESS, {});
    return Object.assign({ xp: 0, correct: 0, answered: 0, streak: 0, best: 0, lastDay: '', today: { day: '', count: 0 }, mastered: 0, passes: 0 }, p);
  }

  const level = xp => Math.floor(Math.sqrt(xp / 100)) + 1;
  const levelStart = lv => (lv - 1) * (lv - 1) * 100;

  // Streak hiển thị: chuỗi chỉ còn hiệu lực nếu hôm nay hoặc hôm qua có luyện
  function liveStreak(p) {
    if (!p.lastDay) return 0;
    const today = dayKey();
    const yesterday = dayKey(Date.now() - DAY);
    return (p.lastDay === today || p.lastDay === yesterday) ? p.streak : 0;
  }

  function todayCount(p) { return p.today.day === dayKey() ? p.today.count : 0; }

  function dueIds() {
    const wrong = read(KEYS.WRONG, {});
    const now = Date.now();
    return Object.values(wrong).filter(w => !w.due || w.due <= now).map(w => w.id);
  }

  // Ghi nhận kết quả một ván: SRS câu sai, thống kê chương, tiến độ
  function recordResult(qs, answers, passed) {
    const wrong = read(KEYS.WRONG, {});
    const chapters = read(KEYS.CHAPTERS, {});
    const prog = loadProgress();
    const now = Date.now();
    let answered = 0;
    let correct = 0;
    let mastered = 0;

    qs.forEach((q, idx) => {
      const choice = answers[idx];
      const isRight = choice === q.correct_option;
      if (choice !== undefined) {
        answered++;
        const c = chapters[q.chapter] || { r: 0, t: 0 };
        c.t++;
        if (isRight) { c.r++; correct++; }
        chapters[q.chapter] = c;
      }
      const entry = wrong[q.id];
      if (!isRight) {
        wrong[q.id] = {
          id: q.id,
          question: q.question.slice(0, 80) + '...',
          is_critical: q.is_critical,
          wrongCount: (entry?.wrongCount || 0) + 1,
          box: 0,
          due: now + INTERVALS[0]
        };
      } else if (entry) {
        const box = (entry.box || 0) + 1;
        if (box >= INTERVALS.length) { delete wrong[q.id]; mastered++; }
        else { entry.box = box; entry.due = now + INTERVALS[box]; }
      }
    });

    const before = todayCount(prog);
    prog.answered += answered;
    prog.correct += correct;
    prog.mastered += mastered;
    if (passed) prog.passes++;
    prog.xp += correct * 10 + (passed ? 100 : 0);
    prog.today = { day: dayKey(), count: before + answered };
    if (answered > 0 && prog.lastDay !== dayKey()) {
      prog.streak = prog.lastDay === dayKey(now - DAY) ? prog.streak + 1 : 1;
      prog.lastDay = dayKey();
      prog.best = Math.max(prog.best, prog.streak);
    }

    write(KEYS.WRONG, wrong);
    write(KEYS.CHAPTERS, chapters);
    write(KEYS.PROGRESS, prog);

    const goalHit = before < DAILY_GOAL && prog.today.count >= DAILY_GOAL;
    if (goalHit) Live.toast(`🎯 Hoàn thành mục tiêu hôm nay (${DAILY_GOAL} câu)!`, 'ok', 4000);
    if (mastered > 0) Live.toast(`🧠 Bạn đã thuộc ${mastered} câu từng làm sai!`, 'ok', 4000);
    renderChip();
    return { answered, correct, mastered };
  }

  // Thứ tự câu sai để luyện: đến hạn ôn trước, sau đó các câu sai còn lại
  function wrongPool(all) {
    const wrong = read(KEYS.WRONG, {});
    const now = Date.now();
    const list = Object.values(wrong);
    const due = list.filter(w => !w.due || w.due <= now).map(w => w.id);
    const rest = list.filter(w => w.due && w.due > now).map(w => w.id);
    const byId = new Map(all.map(q => [q.id, q]));
    const pick = ids => ids.map(id => byId.get(id)).filter(Boolean);
    return { due: pick(due), rest: pick(rest) };
  }

  function chapterStats() {
    return read(KEYS.CHAPTERS, {});
  }

  function weakestChapter() {
    const stats = chapterStats();
    let worst = null;
    Object.keys(stats).forEach(ch => {
      const s = stats[ch];
      if (s.t < 10) return;
      const acc = s.r / s.t;
      if (!worst || acc < worst.acc) worst = { ch: Number(ch), acc, t: s.t };
    });
    return worst;
  }

  // ---------- Chip tiến độ ở sảnh ----------
  function renderChip() {
    const el = $('progressChip');
    if (!el) return;
    const p = loadProgress();
    const lv = level(p.xp);
    const need = levelStart(lv + 1) - levelStart(lv);
    const have = p.xp - levelStart(lv);
    const streak = liveStreak(p);
    const today = todayCount(p);
    const due = dueIds().length;
    el.innerHTML = `
      <span class="pc-item" title="Chuỗi ngày luyện liên tiếp">🔥 ${streak} ngày</span>
      <span class="pc-item" title="Số câu đã làm hôm nay / mục tiêu">🎯 ${Math.min(today, 999)}/${DAILY_GOAL}</span>
      <span class="pc-item" title="XP để lên cấp: ${have}/${need}">⭐ Cấp ${lv}</span>
      ${due > 0 ? `<span class="pc-item pc-due" title="Câu sai đến hạn ôn lại">🧠 ${due} câu cần ôn</span>` : ''}
    `;
    const bar = $('progressGoalBar');
    if (bar) bar.style.width = `${Math.min(100, (today / DAILY_GOAL) * 100)}%`;
  }

  // ---------- Tra cứu ----------
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();

  async function ensureQuestions() {
    if (!questions) {
      questions = await get600Questions();
      normIndex = questions.map(q => norm(`${q.question} ${q.options.join(' ')}`));
    }
    return questions;
  }

  function questionHtml(q) {
    const opts = q.options.map((o, i) => `
      <li class="${i + 1 === q.correct_option ? 'sq-correct' : ''}">${i + 1 === q.correct_option ? '✓ ' : ''}${esc(o)}</li>`).join('');
    return `
      <details class="study-q">
        <summary>
          <span class="sq-id">Câu ${q.id}</span>
          <span class="sq-ch">C${q.chapter}</span>
          ${q.is_critical ? '<span class="sq-crit">⚠️ Liệt</span>' : ''}
          <span class="sq-text">${esc(q.question)}</span>
        </summary>
        ${q.image ? `<img class="sq-img" loading="lazy" src="./${esc(q.image)}" alt="Hình minh họa">` : ''}
        <ol class="sq-opts">${opts}</ol>
        ${q.explanation ? `<div class="sq-exp">💡 ${esc(q.explanation)}</div>` : ''}
      </details>`;
  }

  async function runSearch(reset = true) {
    await ensureQuestions();
    const text = norm($('studySearchInput').value.trim());
    const ch = Number($('studyChapterFilter').value) || 0;
    if (reset) {
      searchResults = [];
      questions.forEach((q, i) => {
        if (ch && q.chapter !== ch) return;
        if (text && !normIndex[i].includes(text)) return;
        searchResults.push(q);
      });
      shown = 0;
      $('studySearchResults').innerHTML = '';
    }
    const box = $('studySearchResults');
    const next = searchResults.slice(shown, shown + PAGE);
    box.querySelector('.sq-more')?.remove();
    box.insertAdjacentHTML('beforeend', next.map(questionHtml).join(''));
    shown += next.length;
    if (!searchResults.length) {
      box.innerHTML = '<div class="study-empty">Không tìm thấy câu hỏi phù hợp.</div>';
    } else if (shown < searchResults.length) {
      box.insertAdjacentHTML('beforeend', `<button type="button" class="btn-nav sq-more">Xem thêm (${searchResults.length - shown} câu)</button>`);
      box.querySelector('.sq-more').addEventListener('click', () => runSearch(false));
    }
    $('studySearchCount').textContent = `${searchResults.length} câu`;
  }

  // ---------- Modal ----------
  function switchTab(tab) {
    document.querySelectorAll('.study-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.study-pane').forEach(p => p.classList.toggle('active', p.id === `study-${tab}`));
    if (tab === 'search') runSearch(true);
    if (tab === 'badges') renderBadges();
    if (tab === 'chapters') renderChapters();
  }

  async function renderChapters() {
    const all = await ensureQuestions();
    const stats = chapterStats();
    const names = {};
    const counts = {};
    all.forEach(q => { names[q.chapter] = q.chapter_name; counts[q.chapter] = (counts[q.chapter] || 0) + 1; });
    const weak = weakestChapter();
    const due = dueIds().length;

    const top = [];
    const totalWrong = Object.keys(read(KEYS.WRONG, {})).length;
    if (due > 0) {
      top.push(`<div class="study-suggest"><span>🧠 Có <b>${due}</b> câu sai đến hạn ôn lại hôm nay</span><button type="button" class="btn-sm-primary" id="btnStudyDue">Ôn ngay</button></div>`);
    } else if (totalWrong > 0) {
      top.push(`<div class="study-suggest"><span>📝 Bạn có <b>${totalWrong}</b> câu từng sai (sẽ đến hạn ôn lại sau 1 ngày)</span><button type="button" class="btn-sm-primary" id="btnStudyDue">Luyện lại ngay</button></div>`);
    }
    if (weak) {
      top.push(`<div class="study-suggest warn"><span>📉 Chương yếu nhất: <b>Chương ${weak.ch}</b> (đúng ${Math.round(weak.acc * 100)}% / ${weak.t} câu)</span><button type="button" class="btn-sm-primary" data-chapter="${weak.ch}">Luyện ngay</button></div>`);
    }

    const cards = Object.keys(names).map(ch => {
      const s = stats[ch];
      const acc = s && s.t ? Math.round((s.r / s.t) * 100) : null;
      const cls = acc === null ? '' : (acc >= 80 ? 'good' : (acc >= 60 ? 'mid' : 'bad'));
      return `
        <div class="study-chapter">
          <div class="sc-head"><b>Chương ${ch}</b> · ${counts[ch]} câu</div>
          <div class="sc-name">${esc(names[ch])}</div>
          <div class="sc-acc ${cls}">${acc === null ? 'Chưa luyện' : `Đúng ${acc}% (${s.r}/${s.t})`}</div>
          <div class="sc-bar"><div class="sc-fill ${cls}" style="width: ${acc ?? 0}%"></div></div>
          <div class="sc-actions">
            <button type="button" class="btn-sm-primary" data-chapter="${ch}">⚡ Luyện chương</button>
            <button type="button" class="btn-sm-nav" data-browse="${ch}">📖 Xem câu hỏi</button>
          </div>
        </div>`;
    }).join('');

    const pane = $('study-chapters');
    pane.innerHTML = `${top.join('')}<div class="study-grid">${cards}</div>`;
    pane.querySelectorAll('[data-chapter]').forEach(b => b.addEventListener('click', () => startChapter(Number(b.dataset.chapter))));
    pane.querySelectorAll('[data-browse]').forEach(b => b.addEventListener('click', () => {
      $('studySearchInput').value = '';
      $('studyChapterFilter').value = b.dataset.browse;
      switchTab('search');
    }));
    const dueBtn = $('btnStudyDue');
    if (dueBtn) dueBtn.addEventListener('click', () => { close(); startSoloPractice({ mode: 'wrong', instant: true }); });
  }

  function renderBadges() {
    const p = loadProgress();
    const history = read('gplx_match_history', []);
    const list = [
      { icon: '🚀', name: 'Khởi động', desc: 'Hoàn thành 1 ván', ok: p.answered > 0 || history.length > 0 },
      { icon: '💯', name: 'Trăm câu đúng', desc: 'Trả lời đúng 100 câu', ok: p.correct >= 100, prog: `${Math.min(p.correct, 100)}/100` },
      { icon: '🔥', name: 'Ba ngày liền', desc: 'Luyện 3 ngày liên tiếp', ok: p.best >= 3, prog: `${Math.min(p.best, 3)}/3` },
      { icon: '🏆', name: 'Bảy ngày liền', desc: 'Luyện 7 ngày liên tiếp', ok: p.best >= 7, prog: `${Math.min(p.best, 7)}/7` },
      { icon: '🎓', name: 'Đỗ lý thuyết', desc: 'Đạt B/B1 ít nhất 1 lần', ok: p.passes >= 1 },
      { icon: '🧠', name: 'Thuộc lòng', desc: 'Thuộc 20 câu từng làm sai', ok: p.mastered >= 20, prog: `${Math.min(p.mastered, 20)}/20` }
    ];
    const lv = level(p.xp);
    $('study-badges').innerHTML = `
      <div class="study-level">
        <div class="sl-big">⭐ Cấp ${lv}</div>
        <div class="sl-sub">${p.xp} XP · cần ${levelStart(lv + 1) - p.xp} XP nữa để lên cấp ${lv + 1}</div>
        <div class="sc-bar"><div class="sc-fill good" style="width: ${((p.xp - levelStart(lv)) / (levelStart(lv + 1) - levelStart(lv))) * 100}%"></div></div>
        <div class="sl-sub">🔥 Chuỗi hiện tại ${liveStreak(p)} ngày · kỷ lục ${p.best} ngày · hôm nay ${todayCount(p)}/${DAILY_GOAL} câu</div>
      </div>
      <div class="badge-grid">
        ${list.map(b => `
          <div class="badge-item ${b.ok ? 'on' : ''}">
            <div class="bi-icon">${b.icon}</div>
            <div class="bi-name">${b.name}</div>
            <div class="bi-desc">${b.desc}</div>
            <div class="bi-state">${b.ok ? '✅ Đã đạt' : (b.prog || 'Chưa đạt')}</div>
          </div>`).join('')}
      </div>`;
  }

  function startChapter(ch) {
    close();
    startSoloPractice({ mode: `chapter:${ch}`, instant: true, timeLimit: 1800 });
  }

  function open() {
    $('studyModal').classList.add('active');
    ensureQuestions().then(() => {
      const sel = $('studyChapterFilter');
      if (sel.options.length <= 1) {
        const names = {};
        questions.forEach(q => { names[q.chapter] = q.chapter_name; });
        Object.keys(names).forEach(ch => {
          const o = document.createElement('option');
          o.value = ch;
          o.textContent = `Chương ${ch}: ${names[ch]}`;
          sel.appendChild(o);
        });
      }
      switchTab('chapters');
    });
  }

  function close() { $('studyModal').classList.remove('active'); }

  function init() {
    renderChip();
    const btn = $('btnOpenStudy');
    if (btn) btn.addEventListener('click', open);
    $('btnCloseStudy').addEventListener('click', close);
    $('studyModal').addEventListener('click', e => { if (e.target === $('studyModal')) close(); });
    document.querySelectorAll('.study-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    let t = null;
    $('studySearchInput').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(true), 200); });
    $('studyChapterFilter').addEventListener('change', () => runSearch(true));
  }

  return { init, renderChip, recordResult, wrongPool, dueIds, chapterStats, weakestChapter, open, close };
})();
window.Study = Study;
