import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { createClient as createTurso } from '@libsql/client';
import {
  RULES, DEFINITE_FAILURE, checkAward, checkCharge, checkGrant, chargeMaxFor, classifyAdjust, specMarkdown,
} from './lib/rules.js';
import { makeCipher } from './lib/crypto.js';

// ===== 設定 =====
const env = process.env;
const SENNIN_BASE = (env.SENNIN_BASE || 'https://sennin-account-api.xianrendesu.workers.dev').replace(/\/$/, '');
// 認証画面（ログイン画面）のURL。Apps Script など、API と別の場所にある場合は SENNIN_AUTHORIZE_URL で指定する
const AUTHORIZE_URL = env.SENNIN_AUTHORIZE_URL || `${SENNIN_BASE}/oauth/authorize`;
const CLIENT_ID = env.SENNIN_CLIENT_ID;
const CLIENT_SECRET = env.SENNIN_CLIENT_SECRET;
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
const SESSION_SECRET = env.SESSION_SECRET;
const SCOPES = env.SENNIN_SCOPES || 'profile email points:read points:write';
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;
const ADMIN_SUBS = new Set((env.ADMIN_SUBS || '').split(',').map((s) => s.trim()).filter(Boolean));
// 運営のアカウント（自分のアプリへの支払い・購入の売上の受け取り先）。未設定なら自分のアプリは支払い・購入できない
const OPERATOR_SUB = (env.OPERATOR_SUB || '').trim();
const SECURE = PUBLIC_URL.startsWith('https://');
const SESSION_MS = 14 * 24 * 3600 * 1000;
const COOKIE_SID = 'sid';
const COOKIE_TX = 'sa_tx';
const DEV = ['developer', 'admin'];
const STATUSES = ['draft', 'in_review', 'published', 'suspended'];
const SENSITIVE = ['title', 'description', 'launch_url', 'price_points', 'icon_url', 'thumbnail_url', 'preview_images'];
const ITEM_FIELDS = ['title', 'description', 'icon_url', 'preview_images', 'price_points'];
const ADMIN_FIELDS = ['status', 'trending'];
const TEXT_LIMITS = { title: 80, subtitle: 200, description: 2000, category_label: 60, developer: 80, size: 40, age_rating: 40, sub_price_note: 60, featured_badge: 40, launch_url: 500 };
const IMG_PATH = /^\/img\/[0-9a-f-]{36}$/;
const NOT_LINKED = '仙人アカウントとの連携が切れています。もう一度ログインしてください。';

for (const [k, v] of Object.entries({ SENNIN_CLIENT_ID: CLIENT_ID, SENNIN_CLIENT_SECRET: CLIENT_SECRET, PUBLIC_URL, SESSION_SECRET, TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY })) {
  if (!v) throw new Error(`環境変数 ${k} が未設定です`);
}
const cipher = makeCipher(env.TOKEN_ENCRYPTION_KEY);

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

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
const effectiveRole = (sub, role) => (ADMIN_SUBS.has(sub) ? 'admin' : (role || 'user'));
const basicAuth = () => ({ Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64') });
const publicItem = ({ owner_sub, ...rest }) => rest;
const statusFor = (code) => ({ insufficient_points: 402, scope: 403, not_linked: 403, daily_limit: 429, invalid: 400 }[code] ?? 409);

// 1分あたりの回数制限（プロセス内。複数インスタンスでは別途対策が必要）
const hits = new Map();
function allowed(bucket, key, limit) {
  const now = Date.now();
  const k = `${bucket}:${key}`;
  const recent = (hits.get(k) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) { hits.set(k, recent); return false; }
  recent.push(now);
  hits.set(k, recent);
  return true;
}

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
  return Object.fromEntries((req.get('cookie') || '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf('=');
    return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
  }));
}
function setCookie(res, name, value, maxAgeSec) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`);
}
const clearCookie = (res, name) => setCookie(res, name, '', 0);
const safeNext = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/store.html');

// プロセス内ロック（同じキーの処理を直列化する）
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((r) => (release = r));
  const tail = prev.then(() => current);
  locks.set(key, tail);
  await prev;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// ===== 仙人アカウント（OAuth と、ポイントの API） =====
async function senninRequest(p, { method = 'GET', headers = {}, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(form).toString(); }
  const r = await fetch(SENNIN_BASE + p, init);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

// ポイントを扱うときの失敗（code は lib/rules.js の DEFINITE_FAILURE の分類に従う）
class PointsError extends Error {
  constructor(code, message, points) {
    super(message);
    this.code = code;
    this.points = points;
  }
}

// 利用者ごとの、仙人アカウントのアクセストークン（メモリに1時間ほど持つ）
const accessCache = new Map();

// 連携の更新トークン（暗号化して sennin_links に保存）で、アクセストークンを取り直す。
// 更新トークンはローテーションするので、新しい値を必ず保存し直す。同じ利用者は直列に処理する。
async function pointsToken(sub) {
  const cached = accessCache.get(sub);
  if (cached && cached.expires > Date.now()) return cached.token;
  return withLock(`tok:${sub}`, async () => {
    const again = accessCache.get(sub);
    if (again && again.expires > Date.now()) return again.token;

    const { data, error } = await sb.from('sennin_links').select('refresh_token_enc').eq('sub', sub).maybeSingle();
    if (error) throw error;
    if (!data) throw new PointsError('not_linked', NOT_LINKED);

    const r = await senninRequest('/oauth/token', {
      method: 'POST', headers: basicAuth(),
      form: { grant_type: 'refresh_token', refresh_token: cipher.decrypt(data.refresh_token_enc) },
    });
    if (r.status === 429 || r.status >= 500) throw new PointsError('unknown', '仙人アカウントが混み合っています。時間をおいてお試しください。');
    if (r.status !== 200 || typeof r.body.access_token !== 'string') {
      if (r.body.error === 'invalid_grant' || r.body.error === 'invalid_client') {
        await clearLink(sub);
        throw new PointsError('not_linked', NOT_LINKED);
      }
      throw new PointsError('unknown', '仙人アカウントの確認に失敗しました。時間をおいてお試しください。');
    }
    if (typeof r.body.refresh_token === 'string') await saveLink(sub, r.body.refresh_token);
    const ttl = Number(r.body.expires_in) > 0 ? Number(r.body.expires_in) : 3600;
    accessCache.set(sub, { token: r.body.access_token, expires: Date.now() + (ttl - 60) * 1000 });
    return r.body.access_token;
  });
}

async function saveLink(sub, refreshToken) {
  const { error } = await sb.from('sennin_links').upsert(
    { sub, refresh_token_enc: cipher.encrypt(refreshToken), updated_at: new Date().toISOString() },
    { onConflict: 'sub' }
  );
  if (error) throw error;
}

async function clearLink(sub) {
  accessCache.delete(sub);
  await sb.from('sennin_links').delete().eq('sub', sub);
}

async function isLinked(sub) {
  if (!sub) return false;
  const { data, error } = await sb.from('sennin_links').select('sub').eq('sub', sub).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// 利用者の権限で仙人APIを呼ぶ。401 なら取り直して1回だけ再試行する
async function pointsRequest(sub, url, method, body) {
  const send = async (token) => {
    try {
      const r = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const data = await r.json().catch(() => ({}));
      return { status: r.status, body: data };
    } catch {
      throw new PointsError('unknown', '通信に失敗しました。結果を確かめるため、もう一度お試しください。');
    }
  };
  let r = await send(await pointsToken(sub));
  if (r.status === 401) {
    accessCache.delete(sub);
    r = await send(await pointsToken(sub));
    if (r.status === 401) throw new PointsError('not_linked', NOT_LINKED);
  }
  return r;
}

async function fetchBalance(sub) {
  const r = await pointsRequest(sub, `${SENNIN_BASE}/api/v1/points`, 'GET');
  if (r.status === 200 && r.body?.ok && typeof r.body.points === 'number') return r.body.points;
  if (r.status === 403) throw new PointsError('scope', 'ポイントを見る許可がありません。連携し直してください。');
  throw new PointsError('unknown', 'ポイントを取得できませんでした。時間をおいてお試しください。');
}

// ポイントを加算（正）・減算（負）する。key が同じなら二重には加算・減算されない
async function adjustPoints(sub, { amount, reason, key }) {
  const r = await pointsRequest(sub, `${SENNIN_BASE}/api/v1/points/adjust`, 'POST', {
    amount, reason: String(reason).slice(0, 100), idempotency_key: key,
  });
  const res = classifyAdjust(r.status, r.body);
  if (!res.ok) throw new PointsError(res.code, res.message, res.points);
  return res;
}

// 確定できなかった失敗を、予約・購入の記録に反映して、利用者への答えを作る
async function failureReply(e, table, id) {
  if (e instanceof PointsError && DEFINITE_FAILURE.has(e.code)) {
    await sb.from(table).update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', id);
    return { status: statusFor(e.code), body: { ok: false, code: e.code, error: e.message, points: e.points } };
  }
  console.error('[points] 結果を確かめられない失敗:', e?.message ?? e);
  return { status: 503, body: { ok: false, code: 'unknown', error: '支払いの結果を確かめられませんでした。同じ requestId で、もう一度お試しください。' } };
}

// ===== 売上（作者への支払い） =====
// 購入・支払いのたびに、作者へ全額（手数料なし）を払う売上を作る。払えないときは pending のまま残し、
// 作者が次にログインしたとき・定期的に再送する。同じ売上は一度だけ払う（sale-ID を idempotency_key にする）。
async function paySale(id) {
  const { data: s, error } = await sb.from('app_sales').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!s || s.status !== 'pending') return;
  const { data: item } = await sb.from('items').select('title').eq('id', s.item_id).maybeSingle();
  try {
    const r = await adjustPoints(s.payee_sub, {
      amount: Number(s.amount),
      reason: `アプリの売上：${item?.title ?? 'アプリ'}`,
      key: `app-sale-${id}`,
    });
    await sb.from('app_sales').update({
      status: 'paid', ledger_id: r.ledgerId, attempts: s.attempts + 1, last_error: null, updated_at: new Date().toISOString(),
    }).eq('id', id);
  } catch (e) {
    // 入力の誤りだけ failed にして管理者が確かめる。ほかは pending のまま（あとで再送）
    const status = e instanceof PointsError && e.code === 'invalid' ? 'failed' : 'pending';
    await sb.from('app_sales').update({
      status, attempts: s.attempts + 1, last_error: String(e.message).slice(0, 200), updated_at: new Date().toISOString(),
    }).eq('id', id);
    throw e;
  }
}

async function ensureSale({ payee, itemId, purchaseId = null, chargeId = null, amount }) {
  try {
    const col = purchaseId ? 'purchase_id' : 'charge_id';
    const { error } = await sb.from('app_sales').upsert(
      { payee_sub: payee, item_id: itemId, purchase_id: purchaseId, charge_id: chargeId, amount, status: 'pending' },
      { onConflict: col, ignoreDuplicates: true }
    );
    if (error) throw error;
    const { data, error: readError } = await sb.from('app_sales').select('id').eq(col, purchaseId ?? chargeId).single();
    if (readError) throw readError;
    await paySale(data.id);
  } catch (e) {
    console.error('[sales] 作者への支払いを保留（あとで再送します）:', e?.message ?? e);
  }
}

async function flushSalesFor(payeeSub) {
  const { data } = await sb.from('app_sales').select('id').eq('payee_sub', payeeSub).eq('status', 'pending').limit(50);
  for (const s of data || []) await paySale(s.id).catch(() => {});
}

// 保留の売上を定期的に再送する（連携していない作者は、連携したあとに払われる）
setInterval(async () => {
  try {
    const { data } = await sb.from('app_sales').select('id').eq('status', 'pending').limit(100);
    for (const s of data || []) await paySale(s.id).catch(() => {});
  } catch (e) {
    console.error('[sales] 再送の確認に失敗:', e?.message ?? e);
  }
}, 10 * 60 * 1000).unref();

// 購入・支払いの作者（自分のアプリなら運営）。運営がいないなら、有料の購入・支払いはできない
function payeeFor(buyer, item) {
  if (item.owner_sub !== buyer) return item.owner_sub || null;
  return OPERATOR_SUB || null;
}

// ===== セッション（ログインの識別だけに使う。トークンは持たない） =====
async function loadSession(req) {
  const sid = cookies(req)[COOKIE_SID];
  if (!sid) return null;
  const { data } = await sb.from('sennin_sessions').select('*').eq('sid_hash', sha256hex(sid)).maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return data;
}

async function currentUser(req) {
  const s = req.session;
  if (!s) return null;
  const { data: acc } = await sb.from('accounts').select('*').eq('sub', s.sub).maybeSingle();
  return { sub: s.sub, name: acc?.name ?? s.name, email: acc?.email ?? s.email, role: effectiveRole(s.sub, acc?.role) };
}

async function meWithPoints(req) {
  const u = await currentUser(req);
  if (!u) return null;
  const linked = await isLinked(u.sub);
  let points = null;
  if (linked) {
    try { points = await fetchBalance(u.sub); } catch { points = null; }
  }
  return { ...u, linked, points };
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

async function loadItem(id) {
  const { data, error } = await sb.from('items').select('*').eq('id', String(id)).maybeSingle();
  if (error) throw error;
  return data;
}

// 作者（自分の作品を含む）か、入手している人だけが、アプリのポイント機能を使える
async function canOpen(sub, item) {
  if (!item) return false;
  if (item.owner_sub === sub) return true;
  return item.status === 'published' && owns(sub, item.id);
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

async function certifiedOf(sub) {
  if (!sub) return false;
  const { data } = await sb.from('creators').select('certified').eq('sub', sub).maybeSingle();
  return Boolean(data?.certified);
}

async function loadGrant(itemId) {
  const { data, error } = await sb.from('app_grants').select('*').eq('item_id', itemId).maybeSingle();
  if (error) throw error;
  return data;
}

async function hasConsent(sub, itemId) {
  const { data, error } = await sb.from('app_consents').select('item_id').eq('user_sub', sub).eq('item_id', itemId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// ===== 認証ルート =====
app.get('/auth/login', (req, res) => {
  const verifier = b64u(crypto.randomBytes(48));
  const state = b64u(crypto.randomBytes(16));
  setCookie(res, COOKIE_TX, signPack({ state, verifier, next: safeNext(req.query.next), exp: Date.now() + 600_000 }), 600);
  const u = new URL(AUTHORIZE_URL);
  const params = {
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPES,
    state, code_challenge: b64u(sha256(verifier)), code_challenge_method: 'S256',
  };
  // 既存のクエリ（Apps Script の ?… など）を残したまま、認証のパラメータを足す
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
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

  // 更新トークンは暗号化して sennin_links に保存（ポイントの加算・減算・売上の受け取りに使う）
  if (typeof t.body.refresh_token === 'string') await saveLink(sub, t.body.refresh_token);
  accessCache.set(sub, { token: t.body.access_token, expires: Date.now() + Math.max(60, Number(t.body.expires_in || 3600) - 60) * 1000 });

  const sid = b64u(crypto.randomBytes(32));
  const { error } = await sb.from('sennin_sessions').insert({
    sid_hash: sha256hex(sid), sub, name, email,
    expires_at: new Date(Date.now() + SESSION_MS).toISOString(),
  });
  if (error) throw error;
  setCookie(res, COOKIE_SID, sid, SESSION_MS / 1000);

  // 連携したので、この作者に保留の売上があれば払う（失敗しても、ログインは成立している）
  flushSalesFor(sub).catch(() => {});
  res.redirect(safeNext(tx.next));
});

app.post('/auth/logout', async (req, res) => {
  const s = req.session;
  if (s) await sb.from('sennin_sessions').delete().eq('sid_hash', s.sid_hash);
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
    library = (data || []).map((r) => r.item_id);
  }
  const { data: srcs } = await sb.from('app_sources').select('item_id');
  const withApp = new Set((srcs || []).map((r) => r.item_id));
  res.json({ me, items: items.map((i) => ({ ...publicItem(i), has_app: withApp.has(i.id) })), library });
});

app.get('/api/items/:id/reviews', async (req, res) => {
  const { data, error } = await sb.from('reviews')
    .select('id,author_name,rating,title,body,developer_reply,created_at')
    .eq('item_id', req.params.id).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  res.json((data || []).map((r) => ({
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

// ===== 購入（ストアの商品を仙人ポイントで買う） =====
async function pendingPurchase(sub, item) {
  const { data: found } = await sb.from('purchases').select('*')
    .eq('user_sub', sub).eq('item_id', item.id).eq('status', 'pending').limit(1).maybeSingle();
  if (found) return found; // 通信断などで未確定の購入があれば、同じ購入IDで再送する
  const { data, error } = await sb.from('purchases')
    .insert({ user_sub: sub, item_id: item.id, price_points: item.price_points, reason: `購入: ${item.title}`.slice(0, 100), status: 'pending' })
    .select().single();
  if (error) throw error;
  return data;
}

async function chargePurchase(sub, item, payee, p) {
  let r;
  try {
    r = await adjustPoints(sub, { amount: -Number(p.price_points), reason: `購入: ${item.title}`, key: `purchase-${p.id}` });
  } catch (e) {
    return failureReply(e, 'purchases', p.id);
  }
  await sb.from('purchases').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', p.id);
  await grantLibrary(sub, item.id);
  await ensureSale({ payee, itemId: item.id, purchaseId: p.id, amount: Number(p.price_points) });
  return { status: 200, body: { ok: true, points: r.points } };
}

app.post('/api/purchase', user(), async (req, res) => {
  const itemId = String((req.body || {}).item_id || '');
  const item = await loadItem(itemId);
  if (!item || item.status !== 'published') return res.status(404).json({ error: '商品が見つかりません' });
  const sub = req.account.sub;
  const out = await withLock('buy:' + sub, async () => {
    if (await owns(sub, item.id)) return { status: 200, body: { ok: true, already: true } };
    if (Number(item.price_points) === 0) {
      await grantLibrary(sub, item.id);
      return { status: 200, body: { ok: true, free: true } };
    }
    const payee = payeeFor(sub, item);
    if (!payee) return { status: 400, body: { error: '運営の設定（OPERATOR_SUB）がないため、自分のアプリは購入できません' } };
    if (!(await isLinked(sub))) return { status: 403, body: { error: 'ポイントで購入するには、仙人アカウントとの連携が必要です' } };
    const p = await pendingPurchase(sub, item);
    return chargePurchase(sub, item, payee, p);
  });
  res.status(out.status).json(out.body);
});

// ===== アプリ内課金（sorachat と同じ：確認画面で利用者が押したときだけ払う） =====
// 支払いは「予約 → 仙人アカウントで減算（key = app-charge-予約ID）→ 確定」の順。
// 同じ requestId で押し直しても二重には払わない。確定できなかったものは予約のまま残し、同じ requestId で確かめ直す。
app.post('/api/apps/:id/charge', user(), async (req, res) => {
  const c = checkCharge(req.body);
  if (!c.ok) return res.status(400).json({ ok: false, code: 'invalid', error: c.error });
  const sub = req.account.sub;
  if (!allowed('charge', sub, RULES.chargePerMinute)) {
    return res.status(429).json({ ok: false, code: 'rate_limited', error: '支払いの操作が多すぎます。少し待ってからお試しください。' });
  }
  const item = await loadItem(req.params.id);
  if (!item || item.status === 'draft' || !(await canOpen(sub, item))) {
    return res.status(403).json({ ok: false, code: 'not_owned', error: 'このアプリはまだ入手していません。' });
  }
  const payee = payeeFor(sub, item);
  if (!payee) return res.status(400).json({ ok: false, code: 'invalid', error: '運営の設定がないため、自分のアプリへは支払えません。' });
  const maxPerCharge = chargeMaxFor(await certifiedOf(item.owner_sub));
  if (c.amount > maxPerCharge) {
    return res.status(400).json({ ok: false, code: 'invalid', error: `1回に支払えるのは ${maxPerCharge}pt までです。` });
  }
  if (!(await isLinked(sub))) return res.status(403).json({ ok: false, code: 'not_linked', error: 'ポイントで支払うには、仙人アカウントとの連携が必要です。' });

  const out = await takeCharge({ sub, item, payee, amount: c.amount, title: c.title, requestId: c.requestId });
  res.status(out.status).json(out.body);
});

async function takeCharge({ sub, item, payee, amount, title, requestId }) {
  const { data: existing, error: readError } = await sb.from('app_charges')
    .select('id, amount, status').eq('user_sub', sub).eq('item_id', item.id).eq('request_id', requestId).maybeSingle();
  if (readError) throw readError;
  if (existing && Number(existing.amount) !== amount) {
    return { status: 409, body: { ok: false, code: 'invalid', error: '同じ requestId で、金額の違う支払いは作れません。' } };
  }
  if (existing?.status === 'done') {
    await ensureSale({ payee, itemId: item.id, chargeId: existing.id, amount });
    return { status: 200, body: { ok: true, charged: amount, replayed: true, points: null } };
  }
  if (existing?.status === 'failed') {
    return { status: 409, body: { ok: false, code: 'failed', error: 'この支払いは失敗しています。新しい requestId で、もう一度お試しください。' } };
  }

  let chargeId = existing?.id;
  if (!chargeId) {
    const { data: created, error: insertError } = await sb.from('app_charges')
      .insert({ user_sub: sub, item_id: item.id, request_id: requestId, amount, title, status: 'reserved' })
      .select('id').single();
    if (insertError) throw insertError;
    chargeId = created.id;
  }

  let r;
  try {
    r = await adjustPoints(sub, { amount: -amount, reason: `アプリ「${item.title}」：${title}`, key: `app-charge-${chargeId}` });
  } catch (e) {
    return failureReply(e, 'app_charges', chargeId);
  }
  await sb.from('app_charges').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', chargeId);
  await ensureSale({ payee, itemId: item.id, chargeId, amount });
  return { status: 200, body: { ok: true, charged: amount, replayed: r.replayed, points: r.points } };
}

// ===== 利用者の許可（アカウント情報と、ポイントの配布） =====
// 配布を持つアプリは、開くときに許可を求める。許可していなければ、名前などは渡さない（いつでも取り消せる）
app.get('/api/apps/:id/access', user(), async (req, res) => {
  const sub = req.account.sub;
  const item = await loadItem(req.params.id);
  if (!item || !(await canOpen(sub, item))) {
    return res.status(403).json({ ok: false, code: 'not_owned', error: 'このアプリはまだ入手していません。' });
  }
  const consented = await hasConsent(sub, item.id);
  const grant = await loadGrant(item.id);
  const needsConsent = Boolean(grant?.active);
  const grantInfo = grant?.active ? { remaining: Number(grant.max_points) - Number(grant.used_points), perCall: Number(grant.per_call_max) } : null;
  if (!consented) return res.json({ ok: true, consented: false, needsConsent, grant: grantInfo });
  res.json({
    ok: true, consented: true, needsConsent, grant: grantInfo,
    user: { sub, name: req.account.name ?? null },
    sennin: { linked: await isLinked(sub) },
  });
});

app.post('/api/apps/:id/consent', user(), async (req, res) => {
  const item = await loadItem(req.params.id);
  if (!item || !(await canOpen(req.account.sub, item))) return res.status(403).json({ ok: false, error: 'このアプリはまだ入手していません。' });
  const { error } = await sb.from('app_consents').upsert(
    { user_sub: req.account.sub, item_id: item.id, granted_at: new Date().toISOString() },
    { onConflict: 'user_sub,item_id', ignoreDuplicates: true }
  );
  if (error) throw error;
  res.json({ ok: true, consented: true });
});

app.delete('/api/apps/:id/consent', user(), async (req, res) => {
  await sb.from('app_consents').delete().eq('user_sub', req.account.sub).eq('item_id', String(req.params.id));
  res.json({ ok: true, consented: false });
});

// アプリから利用者へポイントを配る。許可した本人にだけ、管理者の上限の中で配る
app.post('/api/apps/:id/award', user(), async (req, res) => {
  const a = checkAward(req.body);
  if (!a.ok) return res.status(400).json({ ok: false, code: 'invalid', error: a.error });
  const sub = req.account.sub;
  if (!allowed('award', sub, RULES.awardPerMinute)) {
    return res.status(429).json({ ok: false, code: 'rate_limited', error: '配布の依頼が多すぎます。少し待ってからお試しください。' });
  }
  const item = await loadItem(req.params.id);
  if (!item || item.status === 'draft' || !(await canOpen(sub, item))) {
    return res.status(403).json({ ok: false, code: 'not_owned', error: 'このアプリはまだ入手していません。' });
  }
  if (!(await hasConsent(sub, item.id))) return res.status(403).json({ ok: false, code: 'not_consented', error: 'アカウント情報の許可がありません。先に許可してください。' });
  if (!(await isLinked(sub))) return res.status(403).json({ ok: false, code: 'not_linked', error: 'ポイントを受け取るには、仙人アカウントとの連携が必要です。' });

  const grant = await loadGrant(item.id);
  if (!grant?.active) return res.status(403).json({ ok: false, code: 'inactive', error: 'このアプリは、ポイントを配る許可がありません。' });
  if (a.amount > Number(grant.per_call_max)) {
    return res.status(400).json({ ok: false, code: 'per_call_limit', error: `1回に配れるのは ${grant.per_call_max}pt までです。` });
  }

  const { data: rpc, error } = await sb.rpc('app_award_reserve', {
    p_user: sub, p_item: item.id, p_request: a.requestId, p_points: a.amount, p_reason: a.reason,
  });
  if (error) throw error;
  const reserved = rpc ?? {};
  if (reserved.result === 'inactive') return res.status(403).json({ ok: false, code: 'inactive', error: 'このアプリは、ポイントを配る許可がありません。' });
  if (reserved.result === 'exhausted') {
    return res.status(409).json({ ok: false, code: 'exhausted', error: `このアプリが配れるポイントは、あと ${reserved.remaining}pt です。`, remaining: Number(reserved.remaining) });
  }
  if (reserved.result === 'minute_exhausted') {
    return res.status(429).json({ ok: false, code: 'minute_limit', error: `1人が1分間に受け取れるのは ${reserved.limit}pt までです。少し待ってからお試しください。`, remaining: Number(reserved.remaining) });
  }
  if (reserved.result === 'exists') {
    if (reserved.status === 'done') return res.json({ ok: true, awarded: Number(reserved.points), replayed: true, points: null });
    if (reserved.status === 'failed') return res.status(409).json({ ok: false, code: 'failed', error: 'この配布は失敗しています。新しい requestId で、もう一度お試しください。' });
    if (Number(reserved.points) !== a.amount) {
      return res.status(409).json({ ok: false, code: 'invalid', error: '同じ requestId で、ポイントの違う配布は作れません。' });
    }
  }

  // reserved（今回確保した、または前回の確保が途中で止まったもの）。同じ配布IDで加算するので二重にはならない
  if (!reserved.id) return res.status(503).json({ ok: false, code: 'unknown', error: '配布の枠を確保できませんでした。もう一度お試しください。' });
  const awardId = reserved.id;
  const points = Number(reserved.points);
  let r;
  try {
    r = await adjustPoints(sub, { amount: points, reason: `アプリ「${item.title}」${a.reason ? `：${a.reason}` : ''}`, key: `app-award-${awardId}` });
  } catch (e) {
    if (e instanceof PointsError && DEFINITE_FAILURE.has(e.code)) {
      await sb.rpc('app_award_settle', { p_award: awardId, p_status: 'failed' });
      return res.status(statusFor(e.code)).json({ ok: false, code: e.code, error: e.message, points: e.points });
    }
    return res.status(503).json({ ok: false, code: 'unknown', error: 'ポイントの配布結果を確かめられませんでした。同じ requestId で、もう一度お試しください。' });
  }
  await sb.rpc('app_award_settle', { p_award: awardId, p_status: 'done' });
  res.json({ ok: true, awarded: points, replayed: r.replayed, points: r.points });
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
      .map((s) => clip(s, 40)).filter(Boolean).slice(0, 6);
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
  if (f.preview_images?.some((u) => !IMG_PATH.test(u))) return 'プレビュー画像が不正です';
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
  const id = String(body.id || '').trim() || `app-${crypto.randomBytes(4).toString('hex')}`;
  const f = normalizeItem(pickItem(body, isAdminUser));
  const err = checkItem(f);
  if (err) return res.status(400).json({ error: err });
  const html = typeof body.app_html === 'string' ? body.app_html : undefined;
  if (html !== undefined && html.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'HTMLは2MB以下にしてください' });

  const { data: existing } = await sb.from('items').select('*').eq('id', id).maybeSingle();
  let saved;
  if (existing) {
    if (!isAdminUser && existing.owner_sub !== req.account.sub) return res.status(403).json({ error: 'この作品は編集できません' });
    if (!isAdminUser && existing.status === 'published') {
      const { data: src } = await sb.from('app_sources').select('html').eq('item_id', id).maybeSingle();
      const htmlChanged = html !== undefined && (src?.html ?? '') !== html;
      const fieldChanged = SENSITIVE.some((k) => k in f && JSON.stringify(f[k]) !== JSON.stringify(existing[k]));
      if (htmlChanged || fieldChanged) f.status = 'in_review';
    }
    f.updated_at = new Date().toISOString();
    const { data, error } = await sb.from('items').update(f).eq('id', id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    saved = data;
  } else {
    if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(id)) return res.status(400).json({ error: 'IDは英小文字・数字・ハイフンの3〜60文字で指定してください' });
    if (!f.title) return res.status(400).json({ error: 'アプリ名を入力してください' });
    const { data, error } = await sb.from('items')
      .insert({ ...f, id, owner_sub: req.account.sub, status: f.status || 'draft' }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    saved = data;
  }

  if (html !== undefined) {
    if (html.trim()) {
      const { error } = await sb.from('app_sources').upsert({ item_id: id, html, updated_at: new Date().toISOString() }, { onConflict: 'item_id' });
      if (error) throw error;
    } else {
      await sb.from('app_sources').delete().eq('item_id', id);
    }
  }
  res.json(saved);
});

app.post('/api/studio/items/:id/submit', user(...DEV), async (req, res) => {
  const c = await canManageItem(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '作品が見つからないか、権限がありません' });
  if (!['draft', 'suspended'].includes(c.item.status)) return res.status(400).json({ error: 'この状態では審査に出せません' });
  const { data: full } = await sb.from('items').select('icon_url,preview_images').eq('id', c.item.id).single();
  const { data: src } = await sb.from('app_sources').select('item_id').eq('item_id', c.item.id).maybeSingle();
  if (!full?.icon_url || !full?.preview_images?.length || !src) {
    return res.status(400).json({ error: 'アプリ名・アイコン・アプリ画像・HTMLを入力してから審査に出してください' });
  }
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

// 売上と配布の状況（作者が自分のアプリについて見る）
app.get('/api/studio/items/:id/finance', user(...DEV), async (req, res) => {
  const c = await canManageItem(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '作品が見つからないか、権限がありません' });
  const grant = await loadGrant(c.item.id);
  const { data: sales, error } = await sb.from('app_sales').select('amount, status, created_at').eq('item_id', c.item.id).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  const sum = (rows) => rows.reduce((t, r) => t + Number(r.amount), 0);
  res.json({
    sales: {
      paid: sum((sales || []).filter((s) => s.status === 'paid')),
      pending: sum((sales || []).filter((s) => s.status === 'pending')),
      count: (sales || []).length,
      recent: (sales || []).slice(0, 20),
    },
    grant: grant ? {
      active: grant.active, maxPoints: Number(grant.max_points), usedPoints: Number(grant.used_points),
      perCallMax: Number(grant.per_call_max), perUserMinuteMax: Number(grant.per_user_minute_max),
    } : null,
  });
});

app.get('/api/studio/spec', user(...DEV), (_req, res) => {
  res.type('text/markdown; charset=utf-8').send(specMarkdown());
});

app.get('/api/studio/items/:id/source', user(...DEV), async (req, res) => {
  const c = await canManageItem(req.account, req.params.id);
  if (c.code) return res.status(c.code).json({ error: '作品が見つからないか、権限がありません' });
  const { data } = await sb.from('app_sources').select('html').eq('item_id', c.item.id).maybeSingle();
  res.json({ html: data?.html || '' });
});

// ===== アプリ本体（HTML） =====
// 公開アプリは、所有者・購入者・管理者だけが取得できる。サンドボックスで実行され、ログイン情報には触れられない
app.get('/api/apps/:id/html', user(), async (req, res) => {
  const { data: item } = await sb.from('items').select('id,owner_sub,status').eq('id', req.params.id).maybeSingle();
  if (!item) return res.status(404).type('text').send('not found');
  const allowedView = req.account.role === 'admin' || item.owner_sub === req.account.sub
    || (item.status === 'published' && await owns(req.account.sub, item.id));
  if (!allowedView) return res.status(403).type('text').send('forbidden');
  const { data: src } = await sb.from('app_sources').select('html').eq('item_id', item.id).maybeSingle();
  if (!src) return res.status(404).type('text').send('not found');
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': 'sandbox allow-scripts',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.send(src.html);
});

// ===== 管理者専用 =====
app.get('/api/admin/grants', user('admin'), async (_req, res) => {
  const { data: items, error } = await sb.from('items').select('id, title, owner_sub, status').neq('status', 'draft').order('created_at');
  if (error) throw error;
  const { data: grants } = await sb.from('app_grants').select('*');
  const byItem = new Map((grants || []).map((g) => [g.item_id, g]));
  res.json((items || []).map((i) => {
    const g = byItem.get(i.id);
    return {
      item_id: i.id, title: i.title, status: i.status,
      active: Boolean(g?.active), max_points: Number(g?.max_points ?? 0), used_points: Number(g?.used_points ?? 0),
      per_call_max: Number(g?.per_call_max ?? RULES.awardPerCallDefault), per_user_minute_max: Number(g?.per_user_minute_max ?? 0),
    };
  }));
});

// 配布の上限を決める（すでに配った分より少なくはできない）
app.put('/api/admin/grants/:id', user('admin'), async (req, res) => {
  const itemId = String(req.params.id);
  const item = await loadItem(itemId);
  if (!item) return res.status(404).json({ error: 'アプリが見つかりません' });
  const g = checkGrant(req.body);
  if (!g.ok) return res.status(400).json({ error: g.error });
  const current = await loadGrant(itemId);
  const used = Number(current?.used_points ?? 0);
  if (g.maxPoints < used) return res.status(400).json({ error: `すでに ${used}pt 配られているため、上限は ${used}pt より少なくできません` });
  const { error } = await sb.from('app_grants').upsert({
    item_id: itemId, max_points: g.maxPoints, per_call_max: g.perCall, per_user_minute_max: g.perMinute,
    active: g.active, updated_at: new Date().toISOString(),
  }, { onConflict: 'item_id' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, used_points: used });
});

// 審査待ち・公開中などの一覧（管理者ページ用）。公開に必要な項目が揃っているかも返す
app.get('/api/admin/items', user('admin'), async (_req, res) => {
  const { data: items, error } = await sb.from('items')
    .select('id, title, owner_sub, status, price_points, icon_url, preview_images, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  const { data: srcs } = await sb.from('app_sources').select('item_id');
  const withApp = new Set((srcs || []).map((r) => r.item_id));
  res.json((items || []).map((i) => ({
    id: i.id, title: i.title, owner_sub: i.owner_sub, status: i.status, price_points: i.price_points,
    updated_at: i.updated_at,
    ready: {
      icon: Boolean(i.icon_url), image: Boolean((i.preview_images || []).length), html: withApp.has(i.id),
    },
  })));
});

// 状態を変える（公開・停止・審査中に戻す）。公開には、アイコン・画像・HTML が必要
app.post('/api/admin/items/:id/status', user('admin'), async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: '状態が不正です' });
  const item = await loadItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'アプリが見つかりません' });
  if (status === 'published') {
    const { data: src } = await sb.from('app_sources').select('item_id').eq('item_id', item.id).maybeSingle();
    const missing = [];
    if (!item.icon_url) missing.push('アイコン');
    if (!(item.preview_images || []).length) missing.push('アプリ画像');
    if (!src) missing.push('HTML');
    if (missing.length) return res.status(400).json({ error: `公開するには ${missing.join('・')} が必要です` });
  }
  const { error } = await sb.from('items').update({ status, updated_at: new Date().toISOString() }).eq('id', item.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, status });
});

// 認定開発者（1回に払わせられる上限が上がる）
app.put('/api/admin/creators/:sub', user('admin'), async (req, res) => {
  const sub = String(req.params.sub);
  const certified = Boolean((req.body || {}).certified);
  const { error } = await sb.from('creators').upsert({ sub, certified, updated_at: new Date().toISOString() }, { onConflict: 'sub' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, certified });
});

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
