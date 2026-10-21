const fs = require('fs');
const path = require('path');

let cachedQuestions = null;

function getQuestions() {
  if (!cachedQuestions) {
    const filePath = path.join(process.cwd(), 'data', 'questions_600_bca.json');
    cachedQuestions = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return cachedQuestions;
}

function getRandomItems(arr, count) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const allQ = getQuestions();
  const mode = (req.query && req.query.mode) || 'standard';

  let exam = [];
  if (mode === 'critical') {
    const criticalList = allQ.filter(q => q.is_critical);
    exam = getRandomItems(criticalList, 30);
  } else if (mode === 'signs') {
    const signsList = allQ.filter(q => q.chapter === 5 || q.chapter === 6);
    exam = getRandomItems(signsList, 30);
  } else {
    // Chuẩn 30 câu: 6 chương + đảm bảo có câu điểm liệt
    const ch1 = allQ.filter(q => q.chapter === 1 && !q.is_critical);
    const ch2 = allQ.filter(q => q.chapter === 2 && !q.is_critical);
    const ch3 = allQ.filter(q => q.chapter === 3 && !q.is_critical);
    const ch4 = allQ.filter(q => q.chapter === 4 && !q.is_critical);
    const ch5 = allQ.filter(q => q.chapter === 5 && !q.is_critical);
    const ch6 = allQ.filter(q => q.chapter === 6 && !q.is_critical);
    const crit = allQ.filter(q => q.is_critical);

    const selectedCrit = getRandomItems(crit, 3);
    const selectedCh1 = getRandomItems(ch1, 6);
    const selectedCh2 = getRandomItems(ch2, 1);
    const selectedCh3 = getRandomItems(ch3, 1);
    const selectedCh4 = getRandomItems(ch4, 1);
    const selectedCh5 = getRandomItems(ch5, 9);
    const selectedCh6 = getRandomItems(ch6, 9);

    exam = [...selectedCrit, ...selectedCh1, ...selectedCh2, ...selectedCh3, ...selectedCh4, ...selectedCh5, ...selectedCh6];
    exam = exam.sort(() => 0.5 - Math.random());
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    mode,
    total: exam.length,
    questions: exam
  });
};
