# store-service

構成
- public/index.html … ホーム（ストアで入手したアプリを並べる）
- public/store.html … ストア（商品・レビュー・入手・コード引き換え）
- public/run.html   … アプリ実行画面（🏠 でホームに戻る）
- public/admin.html … 管理画面（商品・画像・レビュー・コード）
- server.js         … API・画像配信（画像はTursoにBLOBで保存）
- supabase/schema.sql … テーブル・RLS・シードデータ

## セットアップ
1. Supabase で schema.sql を実行。Authentication → Providers で Anonymous Sign-ins を有効化。
2. Authentication → Users で管理者（メール/パスワード）を作成し、
   `update profiles set is_admin = true where id = '<UUID>';` を実行。
3. Turso でデータベースを作成し、URL とトークンを取得:
   ```
   turso db create store
   turso db show store --url
   turso db tokens create store
   ```
4. 環境変数を設定: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
5. `npm install` → `npm start`（Render / Railway は Build: `npm install`, Start: `npm start`）

## URL
- `/` ホーム / `/store.html` ストア / `/admin.html` 管理画面

## 注意
- 画像は1枚2MB以下（jpg/png/webp）。アップロード前に縮小すると安定します。
- 元のデモにあったレビューのサンプルデータは含めていません（ユーザーIDが必要なため）。
- アイコン画像が無い商品は商品名の1文字目を表示します。
