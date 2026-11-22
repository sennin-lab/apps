// ポイントのルール（サーバーとテストで共有する、副作用のない関数）。
// 数値・失敗の分類は sorachat（server/studioRules.ts の EXT_BRIDGE、extensionPoints.ts、senninPoints.ts）と同じにしてある。

export const RULES = {
  awardMin: 1,
  awardPerCallDefault: 500, // 1回に配れる量の初期値（管理者が変えられる）
  awardPerMinute: 60, // 利用者1人が1分間に配布を頼める回数
  chargeMin: 10, // 1回に払う最小（pt）
  chargeMaxDefault: 1000, // 通常の作者が1回に払わせられる最大（pt）
  chargeMaxCertified: 5000, // 認定開発者の1回の最大（pt）
  chargePerMinute: 20, // 利用者1人が1分間に支払いを頼める回数（確認画面を通すので少なめ）
  titleMax: 40,
  reasonMax: 40,
  requestIdMin: 8,
  requestIdMax: 64,
  intMax: 2147483647,
};

const REQUEST_ID = new RegExp(`^[A-Za-z0-9_-]{${RULES.requestIdMin},${RULES.requestIdMax}}$`);

// 確実に実行されなかった失敗。予約を「失敗」として閉じてよいもの（それ以外は、加算・減算されたか分からない）
export const DEFINITE_FAILURE = new Set(['insufficient_points', 'scope', 'daily_limit', 'invalid', 'not_linked']);

const bad = (error) => ({ ok: false, error });
const isInt = (x, min, max) => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

export function checkAward(body) {
  const v = body ?? {};
  if (!isInt(v.amount, RULES.awardMin, RULES.intMax)) {
    return bad(`配るポイントは ${RULES.awardMin} 以上の整数で指定してください。`);
  }
  const reason = typeof v.reason === 'string' ? v.reason.trim() : '';
  if (reason.length > RULES.reasonMax) return bad(`理由は ${RULES.reasonMax} 文字までです。`);
  const requestId = typeof v.requestId === 'string' ? v.requestId : '';
  if (!REQUEST_ID.test(requestId)) {
    return bad(`requestId は英数字・-・_ の ${RULES.requestIdMin}〜${RULES.requestIdMax} 文字で指定してください。`);
  }
  return { ok: true, amount: v.amount, reason, requestId };
}

export function checkCharge(body) {
  const v = body ?? {};
  if (!isInt(v.amount, RULES.chargeMin, RULES.intMax)) {
    return bad(`支払うポイントは ${RULES.chargeMin} 以上の整数で指定してください。`);
  }
  const title = typeof v.title === 'string' ? v.title.trim() : '';
  if (!title || title.length > RULES.titleMax) return bad(`品名は 1〜${RULES.titleMax} 文字で指定してください。`);
  const requestId = typeof v.requestId === 'string' ? v.requestId : '';
  if (!REQUEST_ID.test(requestId)) {
    return bad(`requestId は英数字・-・_ の ${RULES.requestIdMin}〜${RULES.requestIdMax} 文字で指定してください。`);
  }
  return { ok: true, amount: v.amount, title, requestId };
}

// 管理者が入力する配布の設定（フォームからの文字列も受け付ける）
export function checkGrant(body) {
  const v = body ?? {};
  const maxPoints = Number(v.max_points);
  const perCall = Number(v.per_call_max);
  const perMinute = Number(v.per_user_minute_max ?? 0);
  if (!isInt(maxPoints, 0, RULES.intMax)) return bad('配布の上限は 0 以上の整数で指定してください。');
  if (!isInt(perCall, 1, RULES.intMax)) return bad('1回に配れる上限は 1 以上の整数で指定してください。');
  if (!isInt(perMinute, 0, RULES.intMax)) return bad('1分あたりの上限は 0 以上の整数で指定してください（0 は制限なし）。');
  return { ok: true, maxPoints, perCall, perMinute, active: v.active === true || v.active === 'true' };
}

// 作者の1回の支払いの上限（認定開発者かどうかで変わる）
export function chargeMaxFor(certified) {
  return certified ? RULES.chargeMaxCertified : RULES.chargeMaxDefault;
}

// 仙人アカウントの加算・減算 API の応答を読む。
// status 200 かつ ok のときだけ成功。それ以外は code で「確実に失敗」か「不明」かを分ける。
export function classifyAdjust(status, data = {}) {
  if (status === 200 && data.ok) {
    return {
      ok: true,
      points: Number(data.points),
      ledgerId: typeof data.ledger_id === 'string' ? data.ledger_id : null,
      replayed: Boolean(data.replayed),
    };
  }
  if (status === 409 && data.error === 'insufficient_points') {
    return { ok: false, code: 'insufficient_points', message: 'ポイントが足りません。', points: Number(data.points ?? 0) };
  }
  if (status === 403) {
    return { ok: false, code: 'scope', message: '仙人アカウント側で、ポイントを使う許可が有効になっていません。' };
  }
  if (status === 429 && data.error === 'daily_limit_exceeded') {
    return { ok: false, code: 'daily_limit', message: '今日のポイント利用の上限に達しました。明日もう一度お試しください。' };
  }
  if (status === 429 || status >= 500) {
    return { ok: false, code: 'unknown', message: '仙人アカウントが混み合っています。結果を確かめるため、もう一度お試しください。' };
  }
  if (status === 400 || status === 409) {
    return { ok: false, code: 'invalid', message: String(data.error_description ?? 'ポイントの処理ができませんでした。') };
  }
  return { ok: false, code: 'unknown', message: 'ポイントの処理結果を確かめられませんでした。もう一度お試しください。' };
}

// 開発者向けの仕様（/api/studio/spec で配る）。上の値から作るので、食い違わない
export function specMarkdown() {
  return `# senninstudio for apps：アプリの仕様（AI・開発者向け）

アプリは HTML 1 ファイル（CSS・JavaScript を含む）で作ります。ストアの画面の中の隔離された枠（iframe の sandbox="allow-scripts"）で動き、
ストアのログイン情報・Cookie・画面には触れられません。ポイントや利用者の情報は、下の window.senninapp を通してだけ使えます。

## window.senninapp
- account() … 利用者の名前と、仙人アカウントの連携の有無を返す。利用者の許可が必要。
- consent() … 利用者が許可しているかを返す。
- charge(amount, title, requestId?) … 利用者が確認画面で「支払う」を押したときだけ、仙人ポイントを払う。
  ${RULES.chargeMin}〜${RULES.chargeMaxDefault}pt（認定開発者は ${RULES.chargeMaxCertified}pt）まで。品名は ${RULES.titleMax} 文字まで。
  requestId を同じにして押し直しても二重には払われない。
- award(amount, reason?, requestId?) … 利用者にポイントを配る。利用者の許可が必要。管理者が決めた上限の中でだけ配られる。
  1回の上限と、1人が1分間に受け取れる上限も管理者が決める。

いずれも Promise を返します。失敗すると例外になり、e.code に次のどれかが入ります。
not_consented / not_linked / insufficient_points / scope / daily_limit / rate_limited / exhausted / minute_limit / invalid / unknown。

## 例
\`\`\`js
const me = await senninapp.account();          // 許可が必要
try {
  const r = await senninapp.charge(100, 'ヒント');  // 確認画面が出る
  console.log('支払いました', r.charged);
} catch (e) {
  if (e.code === 'insufficient_points') alert('ポイントが足りません');
}
await senninapp.award(20, '毎日ログイン', 'daily-2026-11-22-user1'); // 同じ requestId は一度だけ
\`\`\`

## 注意
- unknown のときは「結果を確かめられていない」状態です。同じ requestId で押し直してください。
- 支払いは利用者の確認なしには行われません。金額と品名は確認画面に表示されたものがそのまま払われます。
- 利用者の情報（account）と配布（award）は、許可のあとにだけ動きます。
`;
}
