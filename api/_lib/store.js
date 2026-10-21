// Lưu trạng thái phòng dùng chung giữa các instance của Vercel Function.
// Production: Upstash Redis (Vercel Marketplace). Local/dev: bộ nhớ trong process.
const URL_ENV = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN_ENV = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

class MemoryStore {
  constructor() {
    this.kv = new Map();
  }
  async get(k) { return this.kv.has(k) ? this.kv.get(k) : null; }
  async set(k, v) { this.kv.set(k, v); return 'OK'; }
  async del(...ks) { let n = 0; ks.forEach(k => { if (this.kv.delete(k)) n++; }); return n; }
  async incr(k) { const v = (Number(this.kv.get(k)) || 0) + 1; this.kv.set(k, String(v)); return v; }
  async expire() { return 1; }
  async hget(k, f) { const h = this.kv.get(k); return h && f in h ? h[f] : null; }
  async hset(k, obj) { const h = this.kv.get(k) || {}; Object.assign(h, obj); this.kv.set(k, h); return Object.keys(obj).length; }
  async hgetall(k) { const h = this.kv.get(k); return h && Object.keys(h).length ? { ...h } : null; }
  async hdel(k, f) { const h = this.kv.get(k); if (h && f in h) { delete h[f]; return 1; } return 0; }
  async zadd(k, { score, member }) { const z = this.kv.get(k) || []; z.push({ score, member }); this.kv.set(k, z); return 1; }
  async zrange(k, min, max) {
    const z = this.kv.get(k) || [];
    const hi = max === '+inf' ? Infinity : Number(max);
    const excl = String(min).startsWith('(');
    const lo = Number(String(min).replace('(', ''));
    return z.filter(e => (excl ? e.score > lo : e.score >= lo) && e.score <= hi).sort((a, b) => a.score - b.score).map(e => e.member);
  }
  async zremrangebyrank(k, start, stop) {
    const z = (this.kv.get(k) || []).sort((a, b) => a.score - b.score);
    const len = z.length;
    const e = stop < 0 ? len + stop : stop;
    this.kv.set(k, z.filter((_, i) => i < start || i > e));
    return 1;
  }
}

function createStore() {
  if (URL_ENV && TOKEN_ENV) {
    const { Redis } = require('@upstash/redis');
    return new Redis({
      url: URL_ENV,
      token: TOKEN_ENV,
      automaticDeserialization: false,
      enableAutoPipelining: true
    });
  }
  console.warn('⚠️ Chưa cấu hình Upstash Redis: dùng bộ nhớ tạm (chỉ chạy được 1 instance, KHÔNG dùng cho production).');
  return new MemoryStore();
}

// Giữ nguyên giữa các lần gọi khi instance được tái sử dụng
global.__gameStore = global.__gameStore || createStore();
module.exports = global.__gameStore;
module.exports.isMemory = !(URL_ENV && TOKEN_ENV);
