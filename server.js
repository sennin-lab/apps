import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { createClient as createTurso } from '@libsql/client';

// ===== 設定 =====
const env = process.env;
const SENNIN_BASE = (env.SENNIN_BASE || 'https://sennin-account-api.xianrendesu.workers.dev').replace(/\/$/, '');
const CLIENT_ID = env.SENNIN_CLIENT_ID;
const CLIENT_SECRET = env.SENNIN_CLIENT_SECRET;
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
const SESSION_SECRET = env.SESSION_SECRET;
const SCOPES = env.SENNIN_SCOPES || 'profile email points:read points:write';
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;
const ADMIN_SUBS = new Set((env.ADMIN_SUBS || '').split(',').map(s => s.trim()).filter(Boolean));
const SECURE = PUBLIC_URL.startsWith('https://');
const SESSION_MS = 14 * 24 * 3600 * 1000;
const REFRESH_MARGIN = 60 * 1000;
const COOKIE_SID = 'sid';
const COOKIE_TX = 'sa_tx';
const DEV = ['developer', 'admin'];
const STATUSES = ['draft', 'in_review', 'published', 'suspended'];
const SENSITIVE = ['title', 'description', 'launch_url', 'price_points', 'icon_url', 'thumbnail_url', 'preview_images'];
const ITEM_FIELDS = ['title', 'subtitle', 'description', 'category_label', 'developer', 'size', 'age_rating', 'sub_price_note', 'featured_badge', 'launch_url', 'open_mode', 'icon_url', 'thumbnail_url', 'preview_images', 'highlights', 'price_points', 'type', 'gradient', 'icon_bg'];
const ADMIN_FIELDS = ['status', 'trending'];
const TEXT_LIMITS = { title: 80, subtitle: 200, description: 2000, category_label: 60, developer: 80, size: 40, age_rating: 40, sub_price_note: 60, featured_badge: 40, launch_url: 500 };
const IMG_PATH = /^\/img\/[0-9a-f-]{36}$/;

for (const [k, v] of Object.entries({ SENNIN_CLIENT_ID: CLIENT_ID, SENNIN_CLIENT_SECRET: CLIENT_SECRET, PUBLIC_URL, SESSION_SECRET })) {
  if (!v) throw new Error(`環境変数 ${k} が未設定です`);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.get('/admin.html', (_req, res) => res.redirect('/studio.html'));

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const turso = createTurso({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
await turso.execute(`CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

// ===== ユーティリティ =====
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
const clip = (v, n) => { if (v == null) return null; const s = String(v).trim().slice(0, n); return s || null; };
const fresh = (s) => new Date(s.access_expires_at).getTime() - Date.now() > REFRESH_MARGIN;
const effectiveRole = (sub, role) => (ADMIN_SUBS.has(sub) ? 'admin' : (role || 'user'));
const basicAuth = () => ({ Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64') });
const publicItem = ({ owner_sub, ...rest }) => rest;

function signPack(obj) {
  const body = b64u(JSON.stringify(obj));
  return `${body}.${hmac(body)}`;
}
function signUnpack(v) {
  if (typeof v !== 'string' || !v.includes('.')) return null;
  const [body, mac] = v.split('.');
  const want = hmac(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
function cookies(req) {
  return Object.fromEntries((req.get('cookie') || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('=');
    return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
  }));
}
function setCookie(res, name, value, maxAgeSec) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`);
}
const clearCookie = (res, name) => setCookie(res, name, '', 0);
const safeNext = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/store.html');

// プロセス内ロック（同じユーザーの購入、同じセッションのトークン更新を直列化する）
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(r => (release = r));
  const tail = prev.then(() => current);
  locks.set(key, tail);
  await prev;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// ===== 仙人アカウント(OAuth)呼び出し =====
async function senninRequest(p, { method = 'GET', headers = {}, form, json } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(form).toString(); }
  if (json) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
  const r = await fetch(SENNIN_BASE + p, init);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

// ===== セッション管理（トークンはサーバー側のみ保持） =====
async function loadSession(req) {
  const sid = cookies(req)[COOKIE_SID];
  if (!sid) return null;
  const { data } = await sb.from('sennin_sessions').select('*').eq('sid_hash', sha256hex(sid)).maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return data;
}

async function refreshNow(cur) {
  const r = await senninRequest('/oauth/token', {
    method: 'POST', headers: basicAuth(),
    form: { grant_type: 'refresh_token', refresh_token: cur.refresh_token },
  });
  if (r.status === 400 && r.body.error === 'invalid_grant') {
    await sb.from('sennin_sessions').delete().eq('sid_hash', cur.sid_hash);
    return null;
  }
  if (r.status !== 200) throw new Error(`アカウントサーバーエラー(${r.status})`);
  // リフレッシュトークンはローテーションするので必ず保存し直す
  const { data, error } = await sb.from('sennin_sessions').update({
    access_token: r.body.access_token,
    access_expires_at: new Date(Date.now() + r.body.expires_in * 1000).toISOString(),
    refresh_token: r.body.refresh_token,
  }).eq('sid_hash', cur.sid_hash).select().single();
  if (error) throw error;
  return data;
}

async function refreshIfStale(sidHash, usedToken) {
  return withLock('sess:' + sidHash, async () => {
    const { data: cur } = await sb.from('sennin_sessions').select('*').eq('sid_hash', sidHash).maybeSingle();
    if (!cur) return null;
    if (cur.access_token !== usedToken && fresh(cur)) return cur; // 別のリクエストが既に更新済み
    return refreshNow(cur);
  });
}

async function currentSession(session) {
  if (!session) return null;
  if (fresh(session)) return session;
  return refreshIfStale(session.sid_hash, session.access_token);
}

// 利用者のトークンで仙人APIを呼ぶ。セッションが無効なら null
async function senninCall(session, p, opts = {}, retried = false) {
  const s = await currentSession(session);
  if (!s) return null;
  const r = await senninRequest(p, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${s.access_token}` } });
  if (r.status === 401 && !retried) {
    const s2 = await refreshIfStale(s.sid_hash, s.access_token);
    return s2 ? senninCall(s2, p, opts, true) : null;
  }
  return r;
}

async function currentUser(req) {
  const s = await currentSession(req.session);
  if (!s) return null;
  const { data: acc } = await sb.from('accounts').select('*').eq('sub', s.sub).maybeSingle();
  return { sub: s.sub, name: acc?.name ?? s.name, email: acc?.email ?? s.email, role: effectiveRole(s.sub, acc?.role) };
}

async function meWithPoints(req) {
  const u = await currentUser(req);
  if (!u) return null;
  const p = await senninCall(req.session, '/api/v1/points');
  return { ...u, points: p?.status === 200 ? p.body.points : null };
}

app.use(['/api', '/auth'], async (req, _res, next) => {
  try { req.session = await loadSession(req); next(); } catch (e) { next(e); }
});

function user(...roles) {
  return async (req, res, next) => {
    try {
      const u = await currentUser(req);
      if (!u) return res.status(401).json({ error: 'ログインが必要です（再ログインしてください）' });
      if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: '権限がありません' });
      req.account = u;
      next();
    } catch (e) { next(e); }
  };
}

async function owns(sub, itemId) {
  const { data } = await sb.from('library').select('item_id').eq('user_sub', sub).eq('item_id', itemId).maybeSingle();
  return !!data;
}
async function grantLibrary(sub, itemId) {
  await sb.from('library').upsert({ user_sub: sub, item_id: itemId }, { onConflict: 'user_sub,item_id', ignoreDuplicates: true });
}

async function canManageItem(u, itemId) {
  const { data } = await sb.from('items').select('id,owner_sub,status,price_points').eq('id', String(itemId)).maybeSingle();
  if (!data) return { code: 404 };
  if (u.role !== 'admin' && data.owner_sub !== u.sub) return { code: 403 };
  return { item: data };
}
async function canManageReview(u, reviewId) {
  if (!isUuid(reviewId)) return { code: 404 };
  const { data: rv } = await sb.from('reviews').select('id,item_id').eq('id', reviewId).maybeSingle();
  if (!rv) return { code: 404 };
  const c = await canManageItem(u, rv.item_id);
  return c.code ? c : { review: rv };
}

// ===== 認証ルート =====
app.get('/auth/login', (req, res) => {
  const verifier = b64u(crypto.randomBytes(48));
  const state = b64u(crypto.randomBytes(16));
  setCookie(res, COOKIE_TX, signPack({ state, verifier, next: safeNext(req.query.next), exp: Date.now() + 600_000 }), 600);
  const u = new URL('/oauth/authorize', SENNIN_BASE);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPES,
    state, code_challenge: b64u(sha256(verifier)), code_challenge_method: 'S256',
  }).toString();
  res.redirect(u.toString());
});

app.get('/auth/callback', async (req, res) => {
  const tx = signUnpack(cookies(req)[COOKIE_TX]);
  clearCookie(res, COOKIE_TX);
  if (!tx || tx.exp < Date.now()) return res.status(400).send('ログインの有効期限が切れました。もう一度お試しください。');
  if (req.query.error) return res.status(400).send('ログインがキャンセルされたか、許可されませんでした。');
  if (req.query.state !== tx.state || !req.query.code) return res.status(400).send('不正なリクエストです。もう一度お試しください。');

  const t = await senninRequest('/oauth/token', {
    method: 'POST', headers: basicAuth(),
    form: { grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: REDIRECT_URI, code_verifier: tx.verifier },
  });
  if (t.status !== 200 || !t.body.access_token) return res.status(400).send('ログインに失敗しました。もう一度お試しください。');

  const info = await senninRequest('/oauth/userinfo', { headers: { Authorization: `Bearer ${t.body.access_token}` } });
  if (info.status !== 200 || !info.body.sub) return res.status(400).send('アカウント情報を取得できませんでした。');
  const { sub, name = null, email = null } = info.body;

  const { error: accErr } = await sb.from('accounts').upsert(
    { sub, ...(name ? { name } : {}), ...(email ? { email } : {}), last_login_at: new Date().toISOString() },
    { onConflict: 'sub' }
  );
  if (accErr) throw accErr;

  const sid = b64u(crypto.randomBytes(32));
  const { error } = await sb.from('sennin_sessions').insert({
    sid_hash: sha256hex(sid), sub, name, email,
    access_token: t.body.access_token,
    access_expires_at: new Date(Date.now() + t.body.expires_in * 1000).toISOString(),
    refresh_token: t.body.refresh_token,
    expires_at: new Date(Date.now() + SESSION_MS).toISOString(),
  });
  if (error) throw error;
  setCookie(res, COOKIE_SID, sid, SESSION_MS / 1000);
  res.redirect(safeNext(tx.next));
});

app.post('/auth/logout', async (req, res) => {
  const s = await loadSession(req);
  if (s) {
    senninRequest('/oauth/revoke', { method: 'POST', headers: basicAuth(), form: { token: s.refresh_token } }).catch(() => {});
    await sb.from('sennin_sessions').delete().eq('sid_hash', s.sid_hash);
  }
  clearCookie(res, COOKIE_SID);
  res.redirect('/store.html');
});

// ===== 利用者情報・ストア =====
app.get('/api/me', async (req, res) => {
  res.json({ me: await meWithPoints(req) });
});

app.get('/api/store/bootstrap', async (req, res) => {
  const { data: items, error } = await sb.from('items').select('*').eq('status', 'published').order('created_at');
  if (error) throw error;
  const me = await meWithPoints(req);
  let library = [];
  if (me) {
    const { data } = await sb.from('library').select('item_id').eq('user_sub', me.sub);
    library = (data || []).map(r => r.item_id);
  }
  res.json({ me, items: items.map(publicItem), library });
});

app.get('/api/items/:id/reviews', async (req, res) => {
  const { data, error } = await sb.from('reviews')
    .select('id,author_name,rating,title,body,developer_reply,created_at')
    .eq('item_id', req.params.id).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  res.json((data || []).map(r => ({
    id: r.id, author: r.author_name || 'ユーザー', rating: r.rating, title: r.title,
    body: r.body, developer_reply: r.developer_reply, created_at: r.created_at,
  })));
});

app.post('/api/reviews', user(), async (req, res) => {
  const b = req.body || {};
  const itemId = String(b.item_id || '');
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: '評価は1〜5の整数で指定してください' });
  if (!(await owns(req.account.sub, itemId))) return res.status(403).json({ error: '購入後にレビューできます' });
  const { error } = await sb.from('reviews').upsert({
    item_id: itemId, user_sub: req.account.sub, author_name: req.account.name || 'ユーザー',
    rating, title: clip(b.title, 50), body: clip(b.body, 400), updated_at: new Date().toISOString(),
  }, { onConflict: 'item_id,user_sub' });
  if (error) throw error;
  res.json({ ok: true });
});

// ===== 購入（仙人ポイント） =====
async function pendingPurchase({ user_sub, item_id, sku, price_points, reason }) {
  let q = sb.from('purchases').select('*').eq('user_sub', user_sub).eq('item_id', item_id).eq('status', 'pending');
  q = sku ? q.eq('sku', sku) : q.is('sku', null);
  const { data: found } = await q.limit(1).maybeSingle();
  if (found) return found; // 通信断などで未確定の購入があれば同じ購入IDで再送する
  const { data, error } = await sb.from('purchases')
    .insert({ user_sub, item_id, sku, price_points, reason, status: 'pending' }).select().single();
  if (error) throw error;
  return data;
}

async function markFailed(id) {
  await sb.from('purchases').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', id);
}

async function chargePurchase(req, p) {
  let r;
  try {
    r = await senninCall(req.session, '/api/v1/points/adjust', {
      method: 'POST',
      json: { amount: -Number(p.price_points), reason: String(p.reason || '購入').slice(0, 100), idempotency_key: `purchase-${p.id}` },
    });
  } catch {
    return { status: 503, body: { error: '通信に失敗しました。時間をおいて再度お試しください' } };
  }
  if (!r) return { status: 401, body: { error: '再ログインしてください' } };

  if (r.status === 200) {
    await sb.from('purchases').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', p.id);
    if (!p.sku) await grantLibrary(p.user_sub, p.item_id);
    return { status: 200, body: { ok: true, points: r.body.points } };
  }
  if (r.status === 409 && r.body.error === 'insufficient_points') {
    await markFailed(p.id);
    return { status: 402, body: { error: '仙人ポイントが不足しています', points: r.body.points } };
  }
  if (r.status === 403) {
    await markFailed(p.id);
    return { status: 403, body: { error: 'ポイントの利用許可がありません。再ログインして許可してください' } };
  }
  if (r.status === 429 && r.body.error === 'daily_limit_exceeded') {
    await markFailed(p.id);
    return { status: 429, body: { error: '本日のポイント利用上限に達しています' } };
  }
  if (r.status === 400 || (r.status === 409)) {
    await markFailed(p.id);
    return { status: 400, body: { error: r.body.error_description || '購入できませんでした' } };
  }
  if (r.status === 401) return { status: 401, body: { error: '再ログインしてください' } };
  return { status: 503, body: { error: '時間をおいて再度お試しください' } };
}

app.post('/api/purchase', user(), async (req, res) => {
  const itemId = String((req.body || {}).item_id || '');
  const { data: item } = await sb.from('items').select('id,title,price_points,status').eq('id', itemId).maybeSingle();
  if (!item || item.status !== 'published') return res.status(404).json({ error: '商品が見つかりません' });
  const sub = req.account.sub;
  const out = await withLock('buy:' + sub, async () => {
    if (await owns(sub, item.id)) return { status: 200, body: { ok: true, already: true } };
    if (Number(item.price_points) === 0) {
      await grantLibrary(sub, item.id);
      return { status: 200, body: { ok: true, free: true } };
    }
    const p = await pendingPurchase({ user_sub: sub, item_id: item.id, sku: null, price_points: item.price_points, reason: `購入: ${item.title}` });
    return chargePurchase(req, p);
  });
  res.status(out.status).json(out.body);
});

// ===== アプリ内課金（仙人ポイント） =====
app.get('/api/iap/products/:sku', async (req, res) => {
  const { data: p } = await sb.from('iap_products').select('*').eq('sku', req.params.sku).eq('active', true).maybeSingle();
  if (!p) return res.status(404).json({ error: 'この商品は見つかりません' });
  const { data: item } = await sb.from('items').select('title,status').eq('id', p.item_id).maybeSingle();
  if (!item || item.status !== 'published') return res.status(404).json({ error: 'この商品は見つかりません' });
  res.json({ sku: p.sku, name: p.name, price_points: p.price_points, consumable: p.consumable, item_title: item.title });
});

app.get('/api/iap/owned', user(), async (req, res) => {
  const { data: rows } = await sb.from('purchases').select('sku')
    .eq('user_sub', req.account.sub).eq('status', 'completed').not('sku', 'is', null);
  const skus = [...new Set((rows || []).map(r => r.sku))];
  if (!skus.length) return res.json({ skus: [] });
  const { data: prods } = await sb.from('iap_products').select('sku').in('sku', skus).eq('consumable', false);
  res.json({ skus: (prods || []).map(p => p.sku) });
});

app.post('/api/iap/purchase', user(), async (req, res) => {
  const sku = String((req.body || {}).sku || '');
  const { data: prod } = await sb.from('iap_products').select('*').eq('sku', sku).eq('active', true).maybeSingle();
  if (!prod) return res.status(404).json({ error: 'この商品は見つかりません' });
  const sub = req.account.sub;
  const out = await withLock('buy:' + sub, async () => {
    if (!(await owns(sub, prod.item_id))) return { status: 403, body: { error: 'このアプリを入手してから購入できます' } };
    if (!prod.consumable) {
      const { data: done } = await sb.from('purchases').select('id')
        .eq('user_sub', sub).eq('sku', sku).eq('status', 'completed').limit(1).maybeSingle();
      if (done) return { status: 200, body: { ok: true, already: true } };
    }
    const p = await pendingPurchase({ user_sub: sub, item_id: prod.item_id, sku, price_points: prod.price_points, reason: `アプリ内課金: ${prod.name}` });
    return chargePurchase(req, p);
  });
  res.status(out.status).json(out.body);
});

// ===== 引き換えコード =====
app.post('/api/redeem', user(), async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  const { data: c } = await sb.from('codes').select('*').eq('code', code).maybeSingle();
  if (!c) return res.status(404).json({ error: '無効なコードです' });
  if (c.expires_at && new Date(c.expires_at) < new Date()) return res.status(410).json({ error: '期限切れのコードです' });
  if (c.used_count >= c.max_uses) return res.status(410).json({ error: '使用上限に達しています' });
  const { data: upd } = await sb.from('codes').update({ used_count: c.used_count + 1 })
    .eq('code', code).eq('used_count', c.used_count).select();
  if (!upd?.length) return res.status(409).json({ error: '混雑しています。もう一度お試しください' });
  await grantLibrary(req.account.sub, c.item_id);
  res.json({ item_id: c.item_id });
});

// ===== 画像 =====
app.get('/img/:id', async (req, res) => {
  const r = await turso.execute({ sql: 'SELECT mime, data FROM images WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length) return res.sendStatus(404);
  res.set({ 'Content-Type': r.rows[0].mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(Buffer.from(r.rows[0].data));
});

app.post('/api/studio/images', user(...DEV), upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'jpg / png / webp（2MB以下）を指定してください' });
  const id = crypto.randomUUID();
  await turso.execute({ sql: 'INSERT INTO images (id, mime, data) VALUES (?, ?, ?)', args: [id, req.file.mimetype, req.file.buffer] });
  res.json({ url: `/img/${id}` });
});

// ===== senninstudio for apps（開発者・管理者） =====
function normalizeItem(f) {
  for (const [k, n] of Object.entries(TEXT_LIMITS)) if (k in f) f[k] = clip(f[k], n);
  if ('price_points' in f) f.price_points = Number(f.price_points);
  if ('highlights' in f) {
    f.highlights = (Array.isArray(f.highlights) ? f.highlights : String(f.highlights || '').split(','))
      .map(s => clip(s, 40)).filter(Boolean).slice(0, 6);
  }
  if ('preview_images' in f) f.preview_images = Array.isArray(f.preview_images) ? f.preview_images.filter(Boolean).slice(0, 12) : [];
  for (const k of ['icon_url', 'thumbnail_url']) if (k in f) f[k] = f[k] || null;
  if ('trending' in f) f.trending = !!f.trending;
  return f;
}

function pickItem(body, isAdminUser) {
  const out = {};
  for (const k of [...ITEM_FIELDS, ...(isAdminUser ? ADMIN_FIELDS : [])]) if (k in body) out[k] = body[k];
  return out;
}

function checkItem(f) {
  if ('title' in f && !f.title) return 'タイトルを入力してください';
  if ('type' in f && !['app', 'game', 'product'].includes(f.type)) return '種類が不正です';
  if ('open_mode' in f && !['iframe', 'new_tab'].includes(f.open_mode)) return '起動方法が不正です';
  if ('status' in f && !STATUSES.includes(f.status)) return '状態が不正です';
  if ('price_points' in f && !(Number.isInteger(f.price_points) && f.price_points >= 0 && f.price_points <= 1000000)) {
    return '価格（pt）は0〜1,000,000の整数で入力してください';
  }
  if (f.launch_url && !/^https:\/\/\S+$/.test(f.launch_url)) return '起動URLはhttps://で始まる必要があります';
  for (const k of ['icon_url', 'thumbnail_url']) if (f[k] && !IMG_PATH.test(f[k])) return '画像は管理画面からアップロードしたものを指定してください';
  if (f.preview_images?.some(u => !IMG_PATH.test(u))) return 'プレビュー画像が不正です';
  return null;
}

app.get('/api/studio/items', user(...DEV), async (req, res) => {
  let q = sb.from('items').select('*').order('created_at');
  if (req.account.role !== 'admin') q = q.eq('owner_sub', req.account.sub);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
});

app.post('/api/studio/items', user(...DEV), async (req, res) => {
  const isAdminUser = req.account.role === 'admin';
  const body = req.body || {};
  const id = String(body.id || '').trim();
  const f = normalizeItem(pickItem(body, isAdminUser));
  const err = checkItem(f);
  if (err) return res.status(400).json({ error: err });

  const { data: existing } = await sb.from('items').select('*').eq('id', id).maybeSingle();
  if (existing) {
    if (!isAdminUser && existing.owner_sub !== req.account.sub) return res.status(403).json({ error: 'この作品は編集できません' });
    // 公開中の作品の重要項目を開発者が変えたら、再審査に戻す
    if (!isAdminUser && existing.status === 'published'
      && SENSITIVE.some(k => k in f && JSON.stringify(f[k]) !== JSON.stringify(existing[k]))) {
      f.status = 'in_review';
    }
    f.updated_at = new Date().toISOString();
    const { data, error } = await sb.from('items').update(f).eq('id', id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.json(data);
  }

  if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(id)) return res.status(400).json({ error: 'IDは英小文字・数字・ハイフンの3〜60文字で指定してください' });
  if (!f.title) return res.status(400).json({ error: 'タイトルを入力してください' });
  const { data, error } = await sb.from('items')
    .insert({ ...f, id, owner_sub: req.account.sub, status: f.status || 'draft' }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/studio/items/:id/submit', user(...DEV), async (req, res) => {
  const c = await canManageItem(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '作品が見つからないか、権限がありません' });
  if (!['draft', 'suspended'].includes(c.item.status)) return res.status(400).json({ error: 'この状態では審査に出せません' });
  await sb.from('items').update({ status: 'in_review', updated_at: new Date().toISOString() }).eq('id', c.item.id);
  res.json({ ok: true });
});

app.delete('/api/studio/items/:id', user(...DEV), async (req, res) => {
  const c = await canManageItem(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '作品が見つからないか、権限がありません' });
  if (req.account.role !== 'admin' && c.item.status === 'published') {
    return res.status(400).json({ error: '公開中の作品は削除できません（管理者に停止を依頼してください）' });
  }
  await sb.from('items').delete().eq('id', c.item.id);
  res.json({ ok: true });
});

app.get('/api/studio/items/:id/reviews', user(...DEV), async (req, res) => {
  const c = await canManageItem(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '作品が見つからないか、権限がありません' });
  const { data } = await sb.from('reviews').select('*').eq('item_id', c.item.id).order('created_at', { ascending: false });
  res.json(data || []);
});

app.put('/api/studio/reviews/:id/reply', user(...DEV), async (req, res) => {
  const c = await canManageReview(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '見つからないか、権限がありません' });
  const reply = clip((req.body || {}).reply, 400);
  const { error } = await sb.from('reviews').update({
    developer_reply: reply, developer_reply_at: reply ? new Date().toISOString() : null,
  }).eq('id', req.params.id);
  if (error) throw error;
  res.json({ ok: true });
});

app.delete('/api/studio/reviews/:id', user(...DEV), async (req, res) => {
  const c = await canManageReview(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '見つからないか、権限がありません' });
  await sb.from('reviews').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

app.get('/api/studio/items/:id/iap', user(...DEV), async (req, res) => {
  const c = await canManageItem(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '作品が見つからないか、権限がありません' });
  const { data } = await sb.from('iap_products').select('*').eq('item_id', c.item.id).order('created_at');
  res.json(data || []);
});

app.post('/api/studio/iap', user(...DEV), async (req, res) => {
  const b = req.body || {};
  const c = await canManageItem(req.account, String(b.item_id || ''));
  if (c.code) return res.status(c.code).json({ error: '作品が見つからないか、権限がありません' });
  const sku = String(b.sku || '').trim();
  const price = Number(b.price_points);
  if (!/^[A-Za-z0-9_.:-]{3,64}$/.test(sku)) return res.status(400).json({ error: 'SKUは3〜64文字の英数字と _ . : - で指定してください' });
  if (!Number.isInteger(price) || price < 1 || price > 1000000) return res.status(400).json({ error: '価格は1〜1,000,000ptの整数で指定してください' });
  const { data: exist } = await sb.from('iap_products').select('item_id').eq('sku', sku).maybeSingle();
  if (exist && exist.item_id !== c.item.id) return res.status(409).json({ error: 'このSKUは別の作品で使われています' });
  const { error } = await sb.from('iap_products').upsert({
    sku, item_id: c.item.id, name: clip(b.name, 60) || sku, price_points: price,
    consumable: b.consumable !== false, active: true,
  }, { onConflict: 'sku' });
  if (error) throw error;
  res.json({ ok: true });
});

app.delete('/api/studio/iap/:sku', user(...DEV), async (req, res) => {
  const { data: p } = await sb.from('iap_products').select('item_id').eq('sku', req.params.sku).maybeSingle();
  if (!p) return res.status(404).json({ error: '見つかりません' });
  const c = await canManageItem(req.account, p.item_id);
  if (c.code) return res.status(c.code).json({ error: '権限がありません' });
  await sb.from('iap_products').delete().eq('sku', req.params.sku);
  res.json({ ok: true });
});

// ===== 管理者専用 =====
app.get('/api/admin/codes', user('admin'), async (_req, res) => {
  const { data } = await sb.from('codes').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/admin/codes', user('admin'), async (req, res) => {
  const { item_id, max_uses = 1, expires_at = null, code } = req.body || {};
  const value = String(code || crypto.randomBytes(5).toString('hex')).toUpperCase();
  const { data, error } = await sb.from('codes').insert({
    code: value, item_id, max_uses: Number(max_uses) || 1,
    expires_at: expires_at ? new Date(expires_at).toISOString() : null,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/codes/:code', user('admin'), async (req, res) => {
  await sb.from('codes').delete().eq('code', req.params.code);
  res.json({ ok: true });
});

app.post('/api/admin/accounts/role', user('admin'), async (req, res) => {
  const { sub, role } = req.body || {};
  if (!sub || !['user', 'developer'].includes(role)) return res.status(400).json({ error: '入力が不正です' });
  if (ADMIN_SUBS.has(sub)) return res.status(400).json({ error: '管理者はサーバー設定(ADMIN_SUBS)で管理します' });
  const { error } = await sb.from('accounts').upsert({ sub, role }, { onConflict: 'sub' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'サーバーエラーが発生しました' });
});

app.listen(env.PORT || 3000, () => console.log('ready'));
