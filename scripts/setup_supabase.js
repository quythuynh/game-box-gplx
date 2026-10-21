const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function runWithPassword(password) {
  console.log('🔄 Đang kết nối đến Supabase PostgreSQL...');
  const client = new Client({
    host: 'db.bloooykcynsszlqxyebz.supabase.co',
    port: 5432,
    user: 'postgres',
    password: password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  console.log('✅ Kết nối thành công đến database!');

  console.log('🔄 Đang thực thi schema.sql (tạo bảng và các hàm gp_*)...');
  const schemaSql = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
  await client.query(schemaSql);
  console.log('✅ schema.sql đã được thực thi thành công!');

  console.log('🔄 Đang thực thi questions_seed.sql (nạp 600 câu hỏi)...');
  const seedSql = fs.readFileSync(path.join(__dirname, '../supabase/questions_seed.sql'), 'utf8');
  await client.query(seedSql);
  console.log('✅ questions_seed.sql đã được nạp thành công!');

  await client.end();
  console.log('\n🎉 TOÀN BỘ DATABASE SUPABASE ĐÃ ĐƯỢC THIẾT LẬP HOÀN TẤT!');
}

async function runWithToken(token) {
  console.log('🔄 Đang gửi query qua Supabase Management API...');
  const schemaSql = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
  const seedSql = fs.readFileSync(path.join(__dirname, '../supabase/questions_seed.sql'), 'utf8');

  async function query(sql) {
    const res = await fetch('https://api.supabase.com/v1/projects/bloooykcynsszlqxyebz/database/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: sql })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`API Error (${res.status}): ${text}`);
    return text;
  }

  console.log('🔄 Đang chạy schema.sql...');
  await query(schemaSql);
  console.log('✅ schema.sql thành công!');

  console.log('🔄 Đang chạy questions_seed.sql...');
  await query(seedSql);
  console.log('✅ questions_seed.sql thành công!');
  console.log('\n🎉 TOÀN BỘ DATABASE SUPABASE ĐÃ ĐƯỢC THIẾT LẬP HOÀN TẤT!');
}

const input = process.argv[2];
if (!input) {
  console.log('Usage: node scripts/setup_supabase.js <DB_PASSWORD_OR_SUPABASE_ACCESS_TOKEN>');
  process.exit(1);
}

if (input.startsWith('sbp_')) {
  runWithToken(input).catch(e => {
    console.error('❌ Lỗi:', e.message);
    process.exit(1);
  });
} else {
  runWithPassword(input).catch(e => {
    console.error('❌ Lỗi kết nối:', e.message);
    process.exit(1);
  });
}
