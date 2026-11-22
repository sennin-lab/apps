import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { createClient as createTurso } from '@libsql/client';

const app = express();
const root = process.cwd();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(root, 'public')));

const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const turso = createTurso({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

await turso.execute(`CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

async function getUser(req) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  if (!token) return null;
  const { data } = await sbAdmin.auth.getUser(token);
  return data?.user ?? null;
}
async function requireUser(req, res, next) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'ログインが必要です' });
  req.user = user;
  next();
}
async function requireAdmin(req, res, next) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'ログインが必要です' });
  const { data: p } = await sbAdmin.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!p?.is_admin) return res.status(403).json({ error: '管理者のみ利用できます' });
  req.user = user;
  next();
}

app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

app.get('/img/:id', async (req, res) => {
  const r = await turso.execute({
    sql: 'SELECT mime, data FROM images WHERE id = ?',
    args: [req.params.id],
  });
  if (!r.rows.length) return res.sendStatus(404);
  res.set({
    'Content-Type': r.rows[0].mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.send(Buffer.from(r.rows[0].data));
});

app.post('/api/redeem', requireUser, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const { data: c } = await sbAdmin.from('codes').select('*').eq('code', code).maybeSingle();
  if (!c) return res.status(404).json({ error: '無効なコードです' });
  if (c.expires_at && new Date(c.expires_at) < new Date())
    return res.status(410).json({ error: '期限切れのコードです' });
  if (c.used_count >= c.max_uses)
    return res.status(410).json({ error: '使用上限に達しています' });

  const { data: upd } = await sbAdmin.from('codes')
    .update({ used_count: c.used_count + 1 })
    .eq('code', code).eq('used_count', c.used_count).select();
  if (!upd?.length) return res.status(409).json({ error: '混雑しています。もう一度お試しください' });

  await sbAdmin.from('library').upsert(
    { user_id: req.user.id, item_id: c.item_id },
    { onConflict: 'user_id,item_id', ignoreDuplicates: true }
  );
  res.json({ item_id: c.item_id });
});

app.post('/api/admin/images', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'jpg / png / webp（2MB以下）を指定してください' });
  const id = crypto.randomUUID();
  await turso.execute({
    sql: 'INSERT INTO images (id, mime, data) VALUES (?, ?, ?)',
    args: [id, req.file.mimetype, req.file.buffer],
  });
  res.json({ url: `/img/${id}` });
});

app.get('/api/admin/items', requireAdmin, async (_req, res) => {
  const { data, error } = await sbAdmin.from('items').select('*').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/admin/items', requireAdmin, async (req, res) => {
  const { data, error } = await sbAdmin.from('items').upsert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/items/:id', requireAdmin, async (req, res) => {
  const { error } = await sbAdmin.from('items').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  const { data } = await sbAdmin.from('reviews').select('*')
    .eq('item_id', req.query.item_id).order('created_at', { ascending: false });
  res.json(data || []);
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  await sbAdmin.from('reviews').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/codes', requireAdmin, async (_req, res) => {
  const { data } = await sbAdmin.from('codes').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/admin/codes', requireAdmin, async (req, res) => {
  const { item_id, max_uses = 1, expires_at = null, code } = req.body;
  const value = (code || crypto.randomBytes(5).toString('hex')).toUpperCase();
  const { data, error } = await sbAdmin.from('codes')
    .insert({ code: value, item_id, max_uses, expires_at }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/codes/:code', requireAdmin, async (req, res) => {
  await sbAdmin.from('codes').delete().eq('code', req.params.code);
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('ready'));
