// 点数ルール・暗号化の単体テスト（DB と仙人アカウントには接続しない）
// 実行: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, checkAward, checkCharge, checkGrant, chargeMaxFor, classifyAdjust, DEFINITE_FAILURE, specMarkdown } from '../lib/rules.js';
import { makeCipher } from '../lib/crypto.js';

const RID = 'req-12345678';

test('配布の依頼：範囲・理由・requestId を確かめる', () => {
  assert.equal(checkAward({ amount: 10, reason: ' 毎日 ', requestId: RID }).ok, true);
  assert.equal(checkAward({ amount: 0, requestId: RID }).ok, false);
  assert.equal(checkAward({ amount: 1.5, requestId: RID }).ok, false);
  assert.equal(checkAward({ amount: 10, reason: 'x'.repeat(RULES.reasonMax + 1), requestId: RID }).ok, false);
  assert.equal(checkAward({ amount: 10, requestId: 'short' }).ok, false);
  assert.equal(checkAward({ amount: 10, requestId: 'bad id!!!!' }).ok, false);
});

test('支払いの依頼：下限・品名・requestId を確かめる', () => {
  assert.equal(checkCharge({ amount: RULES.chargeMin, title: 'ヒント', requestId: RID }).ok, true);
  assert.equal(checkCharge({ amount: RULES.chargeMin - 1, title: 'ヒント', requestId: RID }).ok, false);
  assert.equal(checkCharge({ amount: 50, title: '', requestId: RID }).ok, false);
  assert.equal(checkCharge({ amount: 50, title: 'x'.repeat(RULES.titleMax + 1), requestId: RID }).ok, false);
});

test('1回の支払いの上限は、認定開発者かどうかで変わる（sorachat と同じ 1000 / 5000）', () => {
  assert.equal(chargeMaxFor(false), 1000);
  assert.equal(chargeMaxFor(true), 5000);
});

test('管理者の配布設定：フォームの文字列も受け付け、負の値は断る', () => {
  const ok = checkGrant({ max_points: '5000', per_call_max: '500', per_user_minute_max: '0', active: 'true' });
  assert.equal(ok.ok, true);
  assert.equal(ok.maxPoints, 5000);
  assert.equal(ok.active, true);
  assert.equal(checkGrant({ max_points: -1, per_call_max: 500 }).ok, false);
  assert.equal(checkGrant({ max_points: 10, per_call_max: 0 }).ok, false);
});

test('加算・減算の応答の分類：確実な失敗と、結果が分からない失敗を分ける', () => {
  assert.equal(classifyAdjust(200, { ok: true, points: 90, ledger_id: 'L1' }).ok, true);
  const insufficient = classifyAdjust(409, { error: 'insufficient_points', points: 3 });
  assert.equal(insufficient.code, 'insufficient_points');
  assert.equal(insufficient.points, 3);
  assert.equal(classifyAdjust(403, {}).code, 'scope');
  assert.equal(classifyAdjust(429, { error: 'daily_limit_exceeded' }).code, 'daily_limit');
  assert.equal(classifyAdjust(400, { error_description: '不正' }).code, 'invalid');
  assert.equal(classifyAdjust(503, {}).code, 'unknown');
  assert.equal(classifyAdjust(429, {}).code, 'unknown');

  // 確実に失敗したものだけ、予約を「失敗」として閉じてよい
  for (const code of ['insufficient_points', 'scope', 'daily_limit', 'invalid', 'not_linked']) assert.ok(DEFINITE_FAILURE.has(code));
  assert.equal(DEFINITE_FAILURE.has('unknown'), false);
});

test('暗号化：同じ文字列に戻り、鍵が違えば読めない・長さが違う鍵は断る', () => {
  const key = '00'.repeat(32);
  const c = makeCipher(key);
  const packed = c.encrypt('refresh-token-xyz');
  assert.notEqual(packed, 'refresh-token-xyz');
  assert.equal(c.decrypt(packed), 'refresh-token-xyz');
  assert.throws(() => makeCipher(key.slice(2)));
  assert.throws(() => makeCipher('11'.repeat(32)).decrypt(packed));
});

test('仕様書：上限の数値が文書に出ている', () => {
  const md = specMarkdown();
  assert.ok(md.includes(String(RULES.chargeMaxDefault)));
  assert.ok(md.includes('window.senninapp'));
});
