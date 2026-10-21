// Sinh supabase/questions_seed.sql từ data/questions_600_bca.json
const fs = require('fs');
const path = require('path');
const qs = require('../data/questions_600_bca.json');
const esc = s => (s == null ? 'null' : "'" + String(s).replace(/'/g, "''") + "'");
const rows = qs.map(q =>
  `(${q.id},${q.chapter},${esc(q.chapter_name)},${esc(q.question)},${esc(q.image)},${esc(JSON.stringify(q.options))}::jsonb,${q.correct_option},${q.is_critical ? 'true' : 'false'},${esc(q.explanation)})`);
let out = '-- Sinh tự động bởi scripts/build_supabase_seed.js\ndelete from questions;\n';
for (let i = 0; i < rows.length; i += 100) {
  out += 'insert into questions(id,chapter,chapter_name,question,image,options,correct_option,is_critical,explanation) values\n' +
    rows.slice(i, i + 100).join(',\n') + ';\n';
}
fs.writeFileSync(path.join(__dirname, '../supabase/questions_seed.sql'), out);
console.log('OK', rows.length, 'câu,', Math.round(out.length / 1024), 'KB');
