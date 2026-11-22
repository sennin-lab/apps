# store-service v2（仙人アカウント対応 ＋ senninstudio for apps）

## 構成
- `public/index.html` … ホーム（入手したアプリを並べる）
- `public/store.html` … ストア（商品・レビュー・仙人ポイントで購入・コード引き換え）
- `public/run.html` … アプリ実行画面（アプリ内課金のブリッジ付き）
- `public/studio.html` … **senninstudio for apps**（作品・サムネイル・画像・レビュー返信・アプリ内課金・審査・管理者機能）
- `server.js` … 仙人アカウントのOAuth（PKCE）、購入API、アプリ内課金、画像配信
- `supabase/schema.sql` … テーブル定義（既存テーブルは削除して作り直し）

## 変更点
- ログイン: Supabase Auth → **仙人アカウント**（OAuth 2.0 認可コード + PKCE）。パスワードはこのサーバーでは扱わない。
- 支払い: アプリ購入・アプリ内課金はすべて**仙人ポイント**（`/api/v1/points/adjust`）。
- 管理画面 `admin.html` は `studio.html` に統合（`/admin.html` は `/studio.html` にリダイレクト）。

## セットアップ
1. **Supabase**: `supabase/schema.sql` を実行（既存テーブルは削除されます。デモ商品は含めていないので studio から登録してください）。Anonymous Sign-ins は不要になりました。
2. **Turso**: 従来どおり `images` テーブルを使います（起動時に自動作成）。
3. **仙人アカウントにアプリを登録**（アカウント画面の「開発者設定」）:
   - リダイレクトURI: `${PUBLIC_URL}/auth/callback`
   - スコープ: `profile email points:read points:write`
   - 発行された `client_id` / `client_secret` を控える。
   - `points:write` は**管理者の承認が必要**です。承認前はログイン時に `invalid_scope` になるので、その場合は `SENNIN_SCOPES="profile email points:read"` で一時的に起動できますが、ポイントの支払いはできません。
4. **環境変数**を設定（`.env.example` 参照）。
5. **管理者の設定**: 一度ログインすると、studio の画面右上に自分のIDが表示されます。それを `ADMIN_SUBS` に設定して再起動します。
6. `npm install` → `npm start`（Render / Railway: Build `npm install`, Start `npm start`）。

## 作品の公開フロー（senninstudio for apps）
1. 開発者が作品を作成（ID・タイトル・価格（pt）・起動URL・サムネイル・画像など）。
2. 「審査に出す」で `審査中` になる。
3. 管理者が状態を `公開` にすると、ストアに表示されます。
- 公開中の作品で、タイトル・説明・起動URL・価格・画像を開発者が変えると、自動的に `審査中` に戻ります。
- レビューは購入した人だけが投稿でき、開発者は返信できます。

## 仙人ポイントの流れ
- 購入: 利用者が確認ダイアログで承認 → サーバーが `amount: -価格` で `/api/v1/points/adjust` を呼ぶ。
- `idempotency_key` は `purchase-<購入ID>`。通信が切れても同じ購入IDで再送するため**二重課金されません**。
- 残高不足・上限超過などで確定に失敗した購入は `failed` になり、ポイントは減りません。
- 価格は「ポイント」の整数です。1pt = 1円の換算で初期値を入れていますが、自由に変えてください。

## アプリ内課金（IAP）の組み込み（アプリ側）
`launch_url` のアプリは、`public/run.html` の iframe 内で次のように呼べます（`open_mode` が `iframe` の場合のみ）。

```js
const requestId = crypto.randomUUID();
window.parent.postMessage({ type: 'sennin:iap', action: 'purchase', sku: 'pro_unlock', requestId }, '*');
window.addEventListener('message', (e) => {
  if (e.data?.type === 'sennin:iap:result' && e.data.requestId === requestId) {
    console.log(e.data); // { ok: true, points: 1200 } または { ok: false, error: '...' }
  }
});
// 購入済みの非消費型SKU一覧: action: 'owned' → e.data.skus
```
- 購入は**利用者の確認ダイアログ**を経由します（アプリが勝手に引き落とすことはできません）。
- SKUは studio の「アプリ内課金」で作品ごとに登録します。作品を入手していない人は購入できません。
- 消費型は何度でも購入でき、買い切り型は1回だけです。

## 仙人アカウントのURLについて
既定の `SENNIN_BASE` は、指定の Cloudflare Workers URL（`https://sennin-account-api.xianrendesu.workers.dev`）です。仕様書の `/oauth/authorize`・`/oauth/token`・`/oauth/userinfo` がこのURLで応答する前提です。もしログイン画面と各エンドポイントを GAS の URL（`https://script.google.com/macros/s/.../exec`）で提供している場合は、`SENNIN_BASE` をそちらに変更してください。

## 既知の制限
- **返金・管理者からのポイント付与は未実装です。** ポイント操作は利用者本人のトークンで行う仕様のため、管理者が他人のポイントを直接動かすことはできません。
- ロック（同じ利用者の購入の直列化、トークン更新の直列化）はプロセス内で行います。**複数インスタンスで動かす場合は、DBの制約やRedisなどに置き換えてください。**
- セッションのトークンはサーバー側（Supabase の `sennin_sessions`）にのみ保存します。Supabase の service_role キーは必ずサーバーの環境変数に置いてください。
- 画像は1枚2MB以下（jpg/png/webp）。アップロードした画像は、作品に保存されるまで孤立したまま残ります。
