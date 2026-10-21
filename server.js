// Server dev local: phục vụ file tĩnh + chạy cùng các handler /api như trên Vercel.
// (Trên Vercel không dùng file này; /api/*.js chạy như serverless functions.)
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/api/emit', (req, res) => require('./api/emit')(req, res));
app.use('/api/poll', (req, res) => require('./api/poll')(req, res));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`🚀 Dev server: http://localhost:${PORT} (realtime qua /api/emit + /api/poll)`);
});
