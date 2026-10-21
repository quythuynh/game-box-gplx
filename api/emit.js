const { handle } = require('./_lib/game');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { event, data, playerId, roomCode } = body;
    if (!event || !playerId) return res.status(400).json({ success: false, message: 'Thiếu event/playerId' });
    const result = await handle(event, data, String(playerId), roomCode ? String(roomCode).toUpperCase() : null);
    return res.status(200).json(result === undefined ? { success: true } : result);
  } catch (err) {
    console.error('emit error', err);
    return res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
};
