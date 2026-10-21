// Địa chỉ server realtime (server.js chạy trên Render/Railway/Fly...).
// Vercel chỉ host file tĩnh, KHÔNG chạy được Socket.io => bắt buộc điền khi deploy Vercel.
// Ví dụ: window.GAME_SERVER_URL = 'https://game-box-gplx.onrender.com';
// Để trống khi chạy `npm start` (server.js phục vụ luôn cả trang).
window.GAME_SERVER_URL = '';
