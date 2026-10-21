const { poll, getRoom } = require('./_lib/game');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { room, pid, since } = req.query || {};
    const code = String(room || '').toUpperCase();
    if (!code || !pid) return res.status(400).json({ error: 'Thiếu room/pid' });
    if (!(await getRoom(code))) return res.status(404).json({ error: 'room-not-found' });
    return res.status(200).json(await poll(code, String(pid), Number(since) || 0));
  } catch (err) {
    console.error('poll error', err);
    return res.status(500).json({ error: err.message });
  }
};
