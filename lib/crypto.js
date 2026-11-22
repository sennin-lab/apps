// 仙人アカウントの更新トークンを暗号化して保存するための小さな関数（AES-256-GCM）。
// 鍵は環境変数 TOKEN_ENCRYPTION_KEY（64 桁の16進数 = 32 バイト）。鍵が変わると、保存済みの連携は読めなくなる。
import crypto from 'crypto';

export function makeCipher(hexKey) {
  const key = Buffer.from(String(hexKey || ''), 'hex');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY は 64 桁の16進数（openssl rand -hex 32 で作成）にしてください');
  }
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
    },
    decrypt(packed) {
      const [iv, tag, body] = String(packed).split('.').map((s) => Buffer.from(s, 'base64'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}
