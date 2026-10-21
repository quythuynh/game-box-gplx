const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const jsonPath = path.join(__dirname, '..', 'data', 'questions_600_bca.json');
const dbPath = path.join(__dirname, '..', 'data', 'questions_600_bca.db');
const sqlPath = path.join(__dirname, '..', 'data', 'temp_init.sql');

const questions = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

let sql = `
DROP TABLE IF EXISTS options;
DROP TABLE IF EXISTS questions;

CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  chapter INTEGER NOT NULL,
  chapter_name TEXT NOT NULL,
  question TEXT NOT NULL,
  image TEXT,
  correct_option INTEGER NOT NULL,
  is_critical INTEGER NOT NULL,
  explanation TEXT
);

CREATE TABLE options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  option_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_correct INTEGER NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions (id)
);

CREATE INDEX idx_questions_chapter ON questions(chapter);
CREATE INDEX idx_questions_critical ON questions(is_critical);
CREATE INDEX idx_options_question ON options(question_id);

BEGIN TRANSACTION;
`;

for (const q of questions) {
  const escQ = q.question.replace(/'/g, "''");
  const escChName = q.chapter_name.replace(/'/g, "''");
  const escExp = (q.explanation || '').replace(/'/g, "''");
  const escImg = q.image ? `'${q.image.replace(/'/g, "''")}'` : 'NULL';
  const isCrit = q.is_critical ? 1 : 0;

  sql += `INSERT INTO questions (id, chapter, chapter_name, question, image, correct_option, is_critical, explanation) VALUES (${q.id}, ${q.chapter}, '${escChName}', '${escQ}', ${escImg}, ${q.correct_option}, ${isCrit}, '${escExp}');\n`;

  q.options.forEach((opt, idx) => {
    const optIdx = idx + 1;
    const isCorrect = (optIdx === q.correct_option) ? 1 : 0;
    const escOpt = opt.replace(/'/g, "''");
    sql += `INSERT INTO options (question_id, option_index, content, is_correct) VALUES (${q.id}, ${optIdx}, '${escOpt}', ${isCorrect});\n`;
  });
}

sql += 'COMMIT;\n';

fs.writeFileSync(sqlPath, sql, 'utf8');
execSync(`sqlite3 "${dbPath}" < "${sqlPath}"`);
fs.unlinkSync(sqlPath);

console.log('✅ SQLite database created successfully at:', dbPath);
