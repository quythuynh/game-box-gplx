const puppeteer = require('puppeteer-core');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runMultiplayerTest() {
  console.log('\n=============================================================');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ REALTIME 2 TRÌNH DUYỆT (CHROME HEADLESS)');
  console.log('=============================================================\n');

  const browser1 = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const browser2 = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page1 = await browser1.newPage();
  const page2 = await browser2.newPage();

  page1.on('console', msg => console.log('🟢 [Host - Nam]:', msg.text()));
  page2.on('console', msg => console.log('🔵 [Player - Lan]:', msg.text()));

  try {
    // 1. Mở trang chủ
    console.log('▶️ BƯỚC 1: Mở http://localhost:3000 trên cả 2 trình duyệt...');
    await page1.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
    await page2.goto('http://localhost:3000', { waitUntil: 'networkidle2' });

    // 2. Browser 1 nhập tên và tạo phòng
    console.log('▶️ BƯỚC 2: Người 1 (Nam Biker) nhập tên và bấm [Tạo Phòng Mới]...');
    await page1.evaluate(() => {
      document.getElementById('playerNameInput').value = 'Nam Biker';
    });
    await page1.click('#btnCreateRoom');

    // Chờ mã phòng xuất hiện
    await page1.waitForFunction(() => {
      const code = document.getElementById('displayRoomCode').textContent;
      return code && code !== '----' && code.length >= 4;
    }, { timeout: 6000 });

    const roomCode = await page1.evaluate(() => document.getElementById('displayRoomCode').textContent);
    console.log(`✅ Người 1 tạo phòng THÀNH CÔNG! Mã phòng là: [${roomCode}]`);

    // 3. Browser 2 nhập tên và nhập mã phòng
    console.log(`▶️ BƯỚC 3: Người 2 (Lan Siêu Tốc) nhập mã phòng [${roomCode}] và bấm [Vào Thi Đấu]...`);
    await page2.evaluate((code) => {
      document.getElementById('playerNameInput').value = 'Lan Siêu Tốc';
      document.getElementById('tabJoinBtn').click();
      document.getElementById('roomCodeInput').value = code;
    }, roomCode);
    await page2.click('#btnJoinRoom');

    // Chờ cả 2 nhìn thấy nhau trong phòng chờ
    console.log('▶️ BƯỚC 4: Kiểm tra phòng chờ xem 2 người chơi đã thấy nhau chưa...');
    await page1.waitForFunction(() => {
      const text = document.getElementById('waitingPlayersList').innerText;
      return text.includes('Nam Biker') && text.includes('Lan Siêu Tốc');
    }, { timeout: 6000 });

    await page2.waitForFunction(() => {
      const text = document.getElementById('waitingPlayersList').innerText;
      return text.includes('Nam Biker') && text.includes('Lan Siêu Tốc');
    }, { timeout: 6000 });
    console.log('✅ CẢ 2 NGƯỜI CHƠI ĐÃ THẤY NHAU TRONG PHÒNG CHỜ REALTIME!');

    // 4. Chủ phòng bấm Bắt đầu thi đấu
    console.log('▶️ BƯỚC 5: Chủ phòng bấm [Bắt Đầu Thi Đấu]...');
    await page1.click('#btnStartGame');

    // Chờ cả 2 đồng bộ chuyển sang màn hình làm bài
    await page1.waitForSelector('#screenGame.active', { timeout: 6000 });
    await page2.waitForSelector('#screenGame.active', { timeout: 6000 });
    console.log('✅ CẢ 2 TRÌNH DUYỆT ĐÃ ĐỒNG BỘ VÀO MÀN HÌNH LÀM BÀI #screenGame (30 CÂU HỎI)!');

    // 5. Test chuột Realtime
    console.log('▶️ BƯỚC 6: Kiểm tra chuột Realtime (Nam di chuột, Lan có nhìn thấy không)...');
    await page1.mouse.move(400, 300);
    await sleep(200);
    await page1.mouse.move(600, 450);

    await page2.waitForSelector('.remote-cursor', { timeout: 6000 });
    const cursorTag = await page2.evaluate(() => document.querySelector('.remote-cursor .cursor-tag')?.innerText);
    console.log(`✅ CHUỘT REALTIME HOẠT ĐỘNG! Lan nhìn thấy con trỏ chuột của: "${cursorTag}"`);

    // 6. Test chọn đáp án Realtime
    console.log('▶️ BƯỚC 7: Kiểm tra chọn đáp án Realtime...');
    console.log('   - Nam chọn Đáp án 2 của Câu 1...');
    await page1.click('.option-card[data-opt="2"]');

    // Kiểm tra Lan có thấy badge của Nam bên trong Đáp án 2 không
    await page2.waitForFunction(() => {
      const badge = document.querySelector('#optTag-0-2');
      return badge && badge.innerText.includes('Nam Biker');
    }, { timeout: 6000 });
    console.log('✅ ĐÁP ÁN REALTIME HOẠT ĐỘNG! Lan thấy ngay Nam Biker chọn Đáp án 2!');

    // Lan chọn Đáp án 1 của Câu 1
    console.log('   - Lan chọn Đáp án 1 của Câu 1...');
    await page2.click('.option-card[data-opt="1"]');

    await page1.waitForFunction(() => {
      const badge = document.querySelector('#optTag-0-1');
      return badge && badge.innerText.includes('Lan Siêu Tốc');
    }, { timeout: 6000 });
    console.log('✅ ĐÁP ÁN REALTIME HOẠT ĐỘNG! Nam thấy ngay Lan Siêu Tốc chọn Đáp án 1!');

    // 7. Kiểm tra thanh Top Bar & Palette Realtime
    const opponentsOnPage1 = await page1.evaluate(() => document.getElementById('liveOpponentsBar').innerText);
    console.log('📊 Trạng thái thanh tiến độ đối thủ (Top Bar):', opponentsOnPage1.replace(/\n+/g, ' | '));

    console.log('\n=============================================================');
    console.log('🎉 KẾT QUẢ: TẤT CẢ CÁC TÍNH NĂNG REALTIME HOẠT ĐỘNG 100% XUẤT SẮC!');
    console.log('=============================================================\n');

  } catch (err) {
    console.error('❌ Lỗi trong quá trình kiểm thử:', err.message);
  } finally {
    await browser1.close();
    await browser2.close();
  }
}

runMultiplayerTest();
