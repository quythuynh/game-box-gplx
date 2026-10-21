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

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const questions = getQuestions();
  const { chapter, critical, limit } = req.query || {};

  let result = questions;
  if (chapter) {
    result = result.filter(q => q.chapter === parseInt(chapter, 10));
  }
  if (critical === 'true') {
    result = result.filter(q => q.is_critical);
  }
  if (limit) {
    result = result.slice(0, parseInt(limit, 10));
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    total: result.length,
    questions: result
  });
};
