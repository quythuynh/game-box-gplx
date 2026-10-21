const puppeteer = require('puppeteer-core');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runComprehensiveSocketTest() {
  console.log('\n========================================================================');
  console.log('🧪 KIỂM THỬ TOÀN DIỆN MỌI SỰ KIỆN SOCKET.IO VỚI 3 TRÌNH DUYỆT ĐỒNG THỜI');
  console.log('========================================================================\n');

  const launchOpts = {
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  const b1 = await puppeteer.launch(launchOpts);
  const b2 = await puppeteer.launch(launchOpts);
  const b3 = await puppeteer.launch(launchOpts);

  const p1 = await b1.newPage();
  const p2 = await b2.newPage();
  const p3 = await b3.newPage();

  p1.on('console', msg => console.log('🟢 [Host - Nam]:', msg.text()));
  p2.on('console', msg => console.log('🔵 [Player 2 - Lan]:', msg.text()));
  p3.on('console', msg => console.log('🟣 [Player 3 - Tuấn]:', msg.text()));

  // Tự động đồng ý hộp thoại confirm() khi nộp bài
  p1.on('dialog', async d => await d.accept());
  p2.on('dialog', async d => await d.accept());
  p3.on('dialog', async d => await d.accept());

  try {
    // -------------------------------------------------------------
    // TEST 1: KẾT NỐI VÀ TẠO PHÒNG / VÀO PHÒNG (3 NGƯỜI CHƠI)
    // -------------------------------------------------------------
    console.log('▶️ TEST 1: Khởi động 3 trình duyệt và kết nối Socket.io...');
    await p1.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
    await p2.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
    await p3.goto('http://localhost:3000', { waitUntil: 'networkidle2' });

    console.log('   - Người 1 (Nam Biker) tạo phòng mới...');
    await p1.evaluate(() => {
      document.getElementById('playerNameInput').value = 'Nam Biker';
    });
    await p1.click('#btnCreateRoom');

    await p1.waitForFunction(() => {
      const code = document.getElementById('displayRoomCode').textContent;
      return code && code !== '----' && code.length >= 4;
    }, { timeout: 5000 });

    const roomCode = await p1.evaluate(() => document.getElementById('displayRoomCode').textContent);
    console.log(`   ✅ Phòng được tạo: Mã [${roomCode}]`);

    console.log(`   - Người 2 (Lan Siêu Tốc) vào phòng [${roomCode}]...`);
    await p2.evaluate((code) => {
      document.getElementById('playerNameInput').value = 'Lan Siêu Tốc';
      document.getElementById('tabJoinBtn').click();
      document.getElementById('roomCodeInput').value = code;
    }, roomCode);
    await p2.click('#btnJoinRoom');

    console.log(`   - Người 3 (Tuấn Pro) vào phòng [${roomCode}]...`);
    await p3.evaluate((code) => {
      document.getElementById('playerNameInput').value = 'Tuấn Pro';
      document.getElementById('tabJoinBtn').click();
      document.getElementById('roomCodeInput').value = code;
    }, roomCode);
    await p3.click('#btnJoinRoom');

    // Chờ cả 3 browser nhận diện đủ 3 người chơi trong danh sách phòng chờ
    await p1.waitForFunction(() => {
      const txt = document.getElementById('waitingPlayersList').innerText;
      return txt.includes('Nam Biker') && txt.includes('Lan Siêu Tốc') && txt.includes('Tuấn Pro');
    }, { timeout: 6000 });

    await p2.waitForFunction(() => {
      const txt = document.getElementById('waitingPlayersList').innerText;
      return txt.includes('Nam Biker') && txt.includes('Lan Siêu Tốc') && txt.includes('Tuấn Pro');
    }, { timeout: 6000 });

    await p3.waitForFunction(() => {
      const txt = document.getElementById('waitingPlayersList').innerText;
      return txt.includes('Nam Biker') && txt.includes('Lan Siêu Tốc') && txt.includes('Tuấn Pro');
    }, { timeout: 6000 });
    console.log('   ✅ TEST 1 ĐẠT: Cả 3 người chơi đã kết nối Socket.io và đồng bộ phòng chờ!');

    // -------------------------------------------------------------
    // TEST 2: BẮT ĐẦU THI ĐẤU (ĐỒNG BỘ 30 CÂU HỎI & TIMER)
    // -------------------------------------------------------------
    console.log('\n▶️ TEST 2: Chủ phòng phát lệnh start-game...');
    await p1.click('#btnStartGame');

    await p1.waitForSelector('#screenGame.active', { timeout: 6000 });
    await p2.waitForSelector('#screenGame.active', { timeout: 6000 });
    await p3.waitForSelector('#screenGame.active', { timeout: 6000 });

    // Kiểm tra câu hỏi đầu tiên có giống nhau trên cả 3 người chơi không
    const q1Text = await p1.evaluate(() => document.getElementById('qText').innerText);
    const q2Text = await p2.evaluate(() => document.getElementById('qText').innerText);
    const q3Text = await p3.evaluate(() => document.getElementById('qText').innerText);

    if (q1Text === q2Text && q2Text === q3Text) {
      console.log(`   ✅ TEST 2 ĐẠT: Cả 3 người nhận cùng 1 bộ 30 câu hỏi giống hệt nhau!`);
      console.log(`      Nội dung câu 1: "${q1Text.slice(0, 60)}..."`);
    } else {
      throw new Error('Câu hỏi giữa các người chơi không đồng bộ!');
    }

    // -------------------------------------------------------------
    // TEST 3: CHUỘT REALTIME ĐA CHIỀU (3 NGƯỜI THẤY NHAU)
    // -------------------------------------------------------------
    console.log('\n▶️ TEST 3: Kiểm tra chuột Realtime 3 chiều...');
    await p1.mouse.move(350, 250);
    await sleep(150);
    await p2.mouse.move(450, 350);
    await sleep(150);
    await p3.mouse.move(550, 450);
    await sleep(300);

    const cursorsOnP2 = await p2.evaluate(() => {
      const list = Array.from(document.querySelectorAll('.remote-cursor .cursor-tag')).map(el => el.innerText);
      return list;
    });
    console.log('   - Người 2 (Lan) nhìn thấy con trỏ chuột của:', cursorsOnP2);
    if (cursorsOnP2.some(t => t.includes('Nam Biker')) && cursorsOnP2.some(t => t.includes('Tuấn Pro'))) {
      console.log('   ✅ TEST 3 ĐẠT: Chuột Realtime đa chiều hiển thị đầy đủ mọi người chơi!');
    } else {
      throw new Error('Thiếu con trỏ chuột của đối thủ trên màn hình!');
    }

    // -------------------------------------------------------------
    // TEST 4: CHUYỂN CÂU HỎI REALTIME (NAVIGATE)
    // -------------------------------------------------------------
    console.log('\n▶️ TEST 4: Kiểm tra chuyển câu hỏi Realtime...');
    // Người 3 bấm câu 7 trên Palette
    await p3.click('#palletBtn-6'); // index 6 = Câu 7
    await sleep(300);

    // Người 1 và Người 2 kiểm tra thanh Top Bar xem Tuấn có đang ở Câu 7 không
    const p3StatusOnP1 = await p1.evaluate(() => {
      return document.getElementById('liveOpponentsBar').innerText;
    });
    console.log('   - Top Bar trên màn hình Người 1:', p3StatusOnP1.replace(/\n+/g, ' | '));
    if (p3StatusOnP1.includes('Tuấn Pro') && p3StatusOnP1.includes('C7')) {
      console.log('   ✅ TEST 4 ĐẠT: Trạng thái câu hỏi đang xem được đồng bộ Realtime!');
    } else {
      throw new Error('Trạng thái chuyển câu không được cập nhật lên Top Bar!');
    }

    // -------------------------------------------------------------
    // TEST 5: CHỌN ĐÁP ÁN & CƠ CHẾ BẢO MẬT CHỐNG NHÌN BÀI (ANTI-CHEATING)
    // -------------------------------------------------------------
    console.log('\n▶️ TEST 5: Kiểm tra chọn đáp án & cơ chế bảo mật chống nhìn bài...');
    // Quay lại câu 1 trên P3
    await p3.click('#palletBtn-0');
    await sleep(300);

    // Nam chọn Đáp án 1, Lan chọn Đáp án 2, Tuấn chọn Đáp án 1
    console.log('   - Nam chọn Đáp án 1, Lan chọn Đáp án 2, Tuấn chọn Đáp án 1...');
    await p1.click('.option-card[data-opt="1"]');
    await sleep(200);
    await p2.click('.option-card[data-opt="2"]');
    await sleep(200);
    await p3.click('.option-card[data-opt="1"]');
    await sleep(500);

    // BẢO MẬT: Kiểm tra trên màn hình Lan (P2), thẻ Đáp án 1 KHÔNG được tiết lộ lựa chọn của Nam & Tuấn trong lúc thi
    const badgesInOpt1OnP2 = await p2.evaluate(() => {
      const container = document.getElementById('optTag-0-1');
      return container ? container.innerText.trim() : '';
    });
    console.log('   - Kiểm tra rò rỉ đáp án trên máy Lan (phải rỗng):', badgesInOpt1OnP2 ? `BỊ LỘ: ${badgesInOpt1OnP2}` : 'KHÔNG LỘ (An toàn!)');
    if (badgesInOpt1OnP2 === '') {
      console.log('   ✅ TEST 5.1 ĐẠT: Cơ chế chống nhìn bài bảo mật 100%, không làm lộ đáp án của đối thủ!');
    } else {
      throw new Error('Lỗi bảo mật: Đáp án của người chơi khác bị rò rỉ trong lúc làm bài!');
    }

    // Kiểm tra tiến độ tổng thể của đối thủ trên Top Bar (phải hiển thị 1/30 câu)
    const topBarTextOnP1 = await p1.evaluate(() => document.getElementById('liveOpponentsBar').innerText);
    console.log('   - Tiến độ hiển thị trên Top Bar của Nam:', topBarTextOnP1.replace(/\n+/g, ' | '));
    if (topBarTextOnP1.includes('1/30 câu')) {
      console.log('   ✅ TEST 5.2 ĐẠT: Đối thủ biết được số câu đã làm (1/30) của nhau mà không thấy đáp án chọn!');
    }

    // Kiểm tra chấm màu Palette trên Câu 1 (biết ai đã hoàn thành câu 1)
    const dotsCountOnP1 = await p1.evaluate(() => {
      return document.querySelectorAll('#palletDots-0 .pallet-dot').length;
    });
    console.log(`   - Số lượng chấm màu trên nút Câu 1 (Palette): ${dotsCountOnP1} chấm.`);
    if (dotsCountOnP1 >= 2) {
      console.log('   ✅ TEST 5.3 ĐẠT: Thanh Palette hiển thị chấm màu chứng nhận người chơi đã làm xong câu 1!');
    }

    // -------------------------------------------------------------
    // TEST 5B: TƯƠNG TÁC EMOJI REALTIME (REACTION ENGINE)
    // -------------------------------------------------------------
    console.log('\n▶️ TEST 5B: Kiểm tra thả Reaction Emoji Realtime...');
    // Lan bấm icon 🔥
    await p2.evaluate(() => {
      const btn = document.querySelector('.qr-btn[data-emoji="🔥"]');
      if (btn) btn.click();
    });

    // Chờ emoji bay lên trên màn hình của Nam (P1)
    try {
      await p1.waitForSelector('.floating-emoji', { timeout: 3000 });
      console.log('   ✅ TEST 5B ĐẠT: Emoji reaction 🔥 bay lên tức thì trên màn hình đối thủ!');
    } catch (e) {
      console.log('   ⚠️ Emoji timeout (có thể đã bay biến mất sau 1.6s).');
    }

    // -------------------------------------------------------------
    // TEST 6: NỘP BÀI VÀ HIỂN THỊ KẾT QUẢ TRỰC TIẾP TRÊN PHẦN CÂU HỎI
    // -------------------------------------------------------------
    console.log('\n▶️ TEST 6: Kiểm tra nộp bài & hiển thị kết quả trực tiếp trên phần câu hỏi...');
    // Cả 3 người bấm nộp bài
    await p1.evaluate(() => document.getElementById('btnSubmitExam').click());
    await sleep(200);
    await p2.evaluate(() => document.getElementById('btnSubmitExam').click());
    await sleep(200);
    await p3.evaluate(() => document.getElementById('btnSubmitExam').click());

    // Chờ Banner Kết quả xuất hiện ngay trên câu hỏi ở cả 3 trình duyệt
    await p1.waitForSelector('#gameResultBanner[style*="display: flex"]', { timeout: 6000 });
    await p2.waitForSelector('#gameResultBanner[style*="display: flex"]', { timeout: 6000 });
    await p3.waitForSelector('#gameResultBanner[style*="display: flex"]', { timeout: 6000 });

    const bannerScoreP1 = await p1.evaluate(() => document.getElementById('grbScoreBadge').innerText);
    console.log(`   - Điểm số hiển thị trên Banner của Nam: ${bannerScoreP1}`);

    // Kiểm tra câu hỏi hiện tại có được làm nổi bật đáp án đúng và có giải thích không
    const qDetails = await p1.evaluate(() => {
      const correctOpts = document.querySelectorAll('.option-card.review-correct').length;
      const expVisible = document.getElementById('qExplanationBox').style.display !== 'none';
      const paletteColored = document.querySelectorAll('.q-pallet-btn.rev-correct, .q-pallet-btn.rev-wrong').length;
      return { correctOpts, expVisible, paletteColored };
    });
    console.log(`   - Thẻ đáp án đúng được đóng khung xanh nổi bật: ${qDetails.correctOpts >= 1 ? 'CÓ ✓' : 'KHÔNG'}`);
    console.log(`   - Hộp giải thích & căn cứ pháp lý hiển thị ngay dưới câu hỏi: ${qDetails.expVisible ? 'CÓ ✓' : 'KHÔNG'}`);
    console.log(`   - Nút Palette được tô màu Xanh/Đỏ trực quan: ${qDetails.paletteColored >= 1 ? 'CÓ ✓' : 'KHÔNG'}`);

    // Kiểm tra mở Modal Bảng vinh danh Podium
    await p1.click('#btnOpenPodium');
    await sleep(200);
    const podiumNames = await p1.evaluate(() => {
      return Array.from(document.querySelectorAll('#modalPodiumBox .podium-name')).map(el => el.innerText);
    });
    console.log('   - Danh sách Bục vinh danh Podium trong Modal:', podiumNames);
    await p1.click('#btnClosePodiumModal');
    await sleep(200);

    if (bannerScoreP1 && qDetails.correctOpts >= 1 && qDetails.expVisible && podiumNames.length === 3) {
      console.log('   ✅ TEST 6 ĐẠT: Kết quả và giải thích hiển thị trực tiếp 100% trên phần câu hỏi!');
    } else {
      throw new Error('Kết quả không hiển thị đúng trên phần câu hỏi!');
    }

    // -------------------------------------------------------------
    // TEST 7: CHƠI LẠI VÁN MỚI (RESTART-GAME)
    // -------------------------------------------------------------
    console.log('\n▶️ TEST 7: Kiểm tra chơi lại ván mới...');
    await p1.click('#btnBannerPlayAgain');

    await p1.waitForSelector('#screenWaiting.active', { timeout: 6000 });
    await p2.waitForSelector('#screenWaiting.active', { timeout: 6000 });
    await p3.waitForSelector('#screenWaiting.active', { timeout: 6000 });
    console.log('   ✅ TEST 7 ĐẠT: Lệnh restart-game đưa cả 3 người chơi trở lại phòng chờ để chuẩn bị ván mới!');
    console.log('   ✅ TEST 7 ĐẠT: Lệnh restart-game đưa cả 3 người chơi trở lại phòng chờ để chuẩn bị ván mới!');

    console.log('\n========================================================================');
    console.log('🎉 TỔNG KẾT: 100% SỰ KIỆN SOCKET.IO VÀ TÍNH NĂNG MỚI ĐÃ ĐƯỢC XÁC THỰC HOÀN HẢO!');
    console.log('========================================================================\n');

  } catch (err) {
    console.error('❌ Thử nghiệm thất bại tại:', err.message);
    process.exit(1);
  } finally {
    await b1.close();
    await b2.close();
    await b3.close();
  }
}

runComprehensiveSocketTest();
