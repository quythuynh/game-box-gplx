/**
 * DLPL Driving Theory Questions Crawler
 * Nguồn: https://api.dulieuphapluat.vn/tai-lieu/bo-du-lieu/driving-theory-questions
 * 
 * Cách sử dụng:
 *   node scripts/crawl_dlpl.js --key "dlpl_live_xxxxxxxxxxxxxxxxxxxxxxxx"
 *   hoặc:
 *   export DLPL_API_KEY="dlpl_live_xxxxxxxxxxxxxxxxxxxxxxxx"
 *   node scripts/crawl_dlpl.js
 * 
 * Tùy chọn:
 *   --key, -k       API key từ api.dulieuphapluat.vn (Lấy tại https://api.dulieuphapluat.vn/dang-ky)
 *   --delay, -d     Thời gian chờ giữa các request chi tiết (ms), mặc định 6200ms cho gói Free (10 req/phút)
 *   --per-page      Số bản ghi trên mỗi trang danh sách (mặc định: 50)
 *   --max-items     Giới hạn số câu cần cào trong lần chạy này (hữu ích cho gói Free 100 req/ngày)
 *   --list-only     Chỉ cào danh sách tổng quan, không gọi endpoint chi tiết
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(flag, alias, defaultValue) {
  const idx = args.findIndex(a => a === flag || (alias && a === alias));
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return defaultValue;
}
const hasFlag = (flag, alias) => args.some(a => a === flag || (alias && a === alias));

const API_KEY = getArg('--key', '-k', process.env.DLPL_API_KEY);
const DELAY_MS = parseInt(getArg('--delay', '-d', '6200'), 10);
const PER_PAGE = parseInt(getArg('--per-page', null, '50'), 10);
const MAX_ITEMS = parseInt(getArg('--max-items', null, '0'), 10);
const LIST_ONLY = hasFlag('--list-only', null);

const BASE_URL = 'https://api.dulieuphapluat.vn';
const DATA_DIR = path.join(__dirname, '..', 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'dlpl_progress.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'dlpl_driving_questions.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function printHelp() {
  console.log(`
========================================================================
🚗 DLPL Driving Theory Questions Collector (Bộ 600 câu hỏi BCA B/B1)
========================================================================
API Endpoint: https://api.dulieuphapluat.vn/v1/driving-theory-questions

⚠️  LƯU Ý: API yêu cầu header Authorization: Bearer <API_KEY>.
Nếu bạn chưa có API Key, vui lòng tạo tài khoản miễn phí tại:
👉 https://api.dulieuphapluat.vn/dang-ky

Hạn mức gói Free:
- 10 requests / phút
- 100 requests / ngày (1.000 / tháng)
* Endpoint danh sách trả về: id, question_number, chapter, topic, question
* Endpoint chi tiết /v1/driving-theory-questions/{id} trả về:
  answers, correct_answer, is_critical, image, in_250_set, in_300_set

CÁCH CHẠY:
  node scripts/crawl_dlpl.js --key "dlpl_live_xxxxxxxxxxxxxxxxxxxxxxxx"

TÙY CHỌN:
  --key, -k <string>      API Key
  --delay, -d <number>    Delay giữa các request chi tiết tính bằng ms (Mặc định: 6200ms)
  --per-page <number>     Số item mỗi trang danh sách (Mặc định: 50)
  --max-items <number>    Giới hạn số câu cần tải (VD: --max-items 90 cho ngày hôm nay)
  --list-only             Chỉ tải danh sách câu hỏi tổng quan
========================================================================
`);
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DLPL-Collector/1.0',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          return reject(new Error(`JSON Parse Error (Status ${res.statusCode}): ${body.slice(0, 200)}`));
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        } else {
          const err = new Error(json.message || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.response = json;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Load progress
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch (e) {
      console.warn('⚠️ Could not parse existing progress file. Starting fresh.');
    }
  }
  return {
    list: [],
    details: {},
    lastUpdated: null,
  };
}

function saveProgress(progress) {
  progress.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
}

async function fetchAllList(apiKey) {
  console.log('📡 Đang thu thập danh sách câu hỏi qua /v1/driving-theory-questions...');
  const allItems = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${BASE_URL}/v1/driving-theory-questions?page=${page}&per_page=${PER_PAGE}`;
    console.log(`  -> Đang gọi trang ${page}/${totalPages}...`);

    try {
      const res = await requestJson(url, {
        'Authorization': `Bearer ${apiKey}`,
      });

      const data = res.data;
      const items = data.data || data.items || (Array.isArray(data) ? data : []);
      allItems.push(...items);

      if (data.pagination) {
        totalPages = data.pagination.last_page || data.pagination.total_pages || 1;
      } else if (data.meta) {
        totalPages = data.meta.last_page || 1;
      } else {
        totalPages = page;
      }

      page++;
      await sleep(1000); // 1s giữa các trang danh sách
    } catch (err) {
      if (err.status === 401) {
        throw new Error(`Xác thực không thành công (401 Unauthorized): ${err.message}`);
      }
      if (err.status === 429) {
        console.warn('⚠️ Bị giới hạn tốc độ (429 Rate Limit). Chờ 60 giây...');
        await sleep(60000);
        continue;
      }
      throw err;
    }
  }

  console.log(`✅ Đã lấy xong danh sách: ${allItems.length} câu hỏi.`);
  return allItems;
}

async function fetchDetails(apiKey, list, progress) {
  console.log('\n🔍 Bắt đầu thu thập chi tiết từng câu hỏi (/v1/driving-theory-questions/{id})...');
  const details = progress.details || {};
  let countProcessedThisRun = 0;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const id = item.id;

    if (details[id]) {
      // Đã có trong cache
      continue;
    }

    if (MAX_ITEMS > 0 && countProcessedThisRun >= MAX_ITEMS) {
      console.log(`ℹ️ Đã đạt giới hạn tối đa cho lần chạy này (--max-items ${MAX_ITEMS}). Dừng lại.`);
      break;
    }

    const url = `${BASE_URL}/v1/driving-theory-questions/${id}`;
    let success = false;
    let attempts = 0;

    while (!success && attempts < 3) {
      attempts++;
      try {
        console.log(`[${i + 1}/${list.length}] Đang lấy câu ${item.question_number || id} (ID: ${id})...`);
        const res = await requestJson(url, {
          'Authorization': `Bearer ${apiKey}`,
        });

        const detailData = res.data.data || res.data;
        details[id] = detailData;
        progress.details = details;
        saveProgress(progress);

        countProcessedThisRun++;
        success = true;

        // Nghỉ giữa các request chi tiết để tuân thủ rate limit
        if (DELAY_MS > 0 && i < list.length - 1) {
          await sleep(DELAY_MS);
        }
      } catch (err) {
        if (err.status === 429) {
          console.warn(`⚠️ Rate limit (429) tại câu ID ${id}. Chờ 60 giây...`);
          await sleep(60000);
        } else if (err.status === 401) {
          throw new Error(`Lỗi xác thực: ${err.message}`);
        } else {
          console.error(`❌ Lỗi khi lấy ID ${id} (Thử ${attempts}/3):`, err.message);
          await sleep(3000);
        }
      }
    }
  }

  return details;
}

async function main() {
  if (!API_KEY) {
    printHelp();
    console.error('❌ Lỗi: Bạn chưa cung cấp DLPL API key. Hãy dùng tham số --key hoặc biến DLPL_API_KEY.\n');
    process.exit(1);
  }

  try {
    const progress = loadProgress();

    // 1. Lấy danh sách nếu chưa có
    if (!progress.list || progress.list.length === 0) {
      progress.list = await fetchAllList(API_KEY);
      saveProgress(progress);
    } else {
      console.log(`ℹ️ Đã tìm thấy danh sách câu hỏi lưu trong cache: ${progress.list.length} câu.`);
    }

    if (LIST_ONLY) {
      console.log('Chế độ --list-only: Đã hoàn thành lưu danh sách.');
      return;
    }

    // 2. Lấy chi tiết
    await fetchDetails(API_KEY, progress.list, progress);

    // 3. Hợp nhất và xuất kết quả
    const fullQuestions = progress.list.map(item => {
      const detail = progress.details[item.id] || {};
      return {
        ...item,
        ...detail,
      };
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(fullQuestions, null, 2), 'utf8');
    const completedCount = Object.keys(progress.details).length;
    console.log(`\n🎉 Tiến độ hoàn thành: ${completedCount}/${progress.list.length} câu.`);
    console.log(`📁 Tệp kết quả: ${OUTPUT_FILE}`);

    if (completedCount < progress.list.length) {
      console.log(`💡 Mẹo: Bạn có thể chạy lại lệnh này vào ngày mai hoặc bất kỳ lúc nào để tiếp tục cào phần còn lại mà không lo mất dữ liệu.`);
    }
  } catch (err) {
    console.error('\n❌ Có lỗi xảy ra trong quá trình thực thi:', err.message);
    process.exit(1);
  }
}

main();
