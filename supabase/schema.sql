-- ===== 基本テーブル =====
create table items (
  id text primary key,
  type text not null check (type in ('app','game','product')),
  title text not null,
  subtitle text,
  description text,
  category_label text,
  developer text,
  size text,
  age_rating text,
  price_text text,
  sub_price_note text,
  trending boolean not null default false,
  featured_badge text,
  highlights text[] not null default '{}',
  preview_images text[] not null default '{}',
  icon_url text,
  icon_bg text,
  gradient text,
  preview_gradients text[] not null default '{}',
  whats_new jsonb,
  rating numeric(2,1) not null default 0,
  reviews_count int not null default 0,
  launch_url text,
  open_mode text not null default 'iframe' check (open_mode in ('iframe','new_tab')),
  published boolean not null default true,
  created_at timestamptz not null default now()
);

create table reviews (
  id uuid primary key default gen_random_uuid(),
  item_id text not null references items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  author text,
  rating int not null check (rating between 1 and 5),
  title text,
  body text,
  created_at timestamptz not null default now(),
  unique (item_id, user_id)
);

create table library (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null references items(id) on delete cascade,
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default false
);

create table codes (
  code text primary key,
  item_id text not null references items(id) on delete cascade,
  max_uses int not null default 1,
  used_count int not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- ===== 評価の再集計 =====
create or replace function refresh_item_rating() returns trigger
language plpgsql security definer set search_path = public as $$
declare target text := coalesce(new.item_id, old.item_id);
begin
  update items set
    rating = coalesce((select round(avg(rating)::numeric, 1) from reviews where item_id = target), 0),
    reviews_count = (select count(*) from reviews where item_id = target)
  where id = target;
  return null;
end $$;

create trigger reviews_rating_trg
after insert or update or delete on reviews
for each row execute function refresh_item_rating();

-- ===== 管理者プロフィールの自動作成 =====
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin insert into public.profiles (id) values (new.id); return new; end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function handle_new_user();

-- ===== RLS =====
alter table items enable row level security;
alter table reviews enable row level security;
alter table library enable row level security;
alter table profiles enable row level security;
alter table codes enable row level security; -- ポリシーなし＝サーバー(service_role)のみ

create policy "items: 公開分を読む" on items for select using (published);

create policy "reviews: 誰でも読める" on reviews for select using (true);
create policy "reviews: 自分の分を作成" on reviews for insert to authenticated
  with check (auth.uid() = user_id);
create policy "reviews: 自分の分を更新" on reviews for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "library: 自分のものを読む" on library for select to authenticated
  using (auth.uid() = user_id);
create policy "library: 自分のものを追加" on library for insert to authenticated
  with check (auth.uid() = user_id);

create policy "profiles: 自分を読む" on profiles for select to authenticated
  using (auth.uid() = id);

insert into profiles (id) select id from auth.users on conflict do nothing;

-- ===== シードデータ（商品） =====
insert into items (id, type, title, subtitle, description, category_label, developer, size, age_rating,
  price_text, sub_price_note, trending, featured_badge, highlights, icon_bg, gradient,
  preview_gradients, whats_new, rating, reviews_count) values
('lumina-studio','app','Lumina Raw','プロ品質のフィルム質感と光表現をワンタップで','独自の光学シミュレーションエンジンを搭載した次世代フォトエディタ。自然な階調表現と繊細なグレインで、日常のスナップを映画のワンシーンのように仕上げます。','写真 / ビデオ','Lumina Labs Inc.','64.2 MB','4+','入手','App内課金あり',true,'今トレンドのアプリ',array['16bit RAW現像エンジン','35mmフィルム光学プロファイル','非破壊レイヤー編集'],'bg-gradient-to-br from-sky-400 to-indigo-600','from-slate-900 via-zinc-800 to-stone-900',array['from-sky-900 to-slate-900','from-zinc-800 to-neutral-950'],'{"version":"バージョン 2.4.0","date":"2日前","notes":"・新しいシネマティックカラープロファイル「Kodak Vision 500T」を追加しました。\n・書き出し速度が最大40%向上しました。"}',4.9,1240),
('aether-odyssey','game','Aether Odyssey','風と光の浮遊大陸を巡る静謐な探索アドベンチャー','言葉のない美しい世界を滑空し、古代の共鳴装置を解き明かすオープンエア・アドベンチャー。空間オーディオによる環境音とピアノの旋律が深い没入感を生み出します。','アドベンチャー','Kaze Interactive','1.4 GB','9+','入手','Apple Arcade対応',true,'今週の注目ゲーム',array['120fps ProMotion対応','空間オーディオ完全対応','コントローラ操作サポート'],'bg-gradient-to-br from-indigo-500 to-purple-600','from-indigo-600 via-blue-600 to-cyan-500',array['from-indigo-600 to-purple-700','from-blue-600 to-cyan-500'],'{"version":"バージョン 1.8.2","date":"5日前","notes":"・新エリア「星屑の回廊」を追加しました。"}',4.9,3420),
('minimal-desk-pad','product','Studio Felt Mat','ワークスペースを美しく整えるメリノウールデスクマット','厳選された高密度メリノウールフェルトと天然コルクベースを組み合わせたデスクマット。キーボードの打鍵音を和らげます。','ハードウェア / アクセサリ','Studio Craft','900 × 400 mm','限定品','¥6,800','送料無料 · 翌日お届け',true,'限定デザイン商品',array['100% メリノウールフェルト','滑り止め天然コルク底面','撥水・防汚コーティング'],'bg-gradient-to-br from-stone-600 to-stone-800','from-stone-700 via-neutral-700 to-zinc-800',array['from-stone-700 to-stone-900','from-neutral-600 to-zinc-800'],'{"version":"2026年 秋・冬ロット","date":"1週間前","notes":"・新色「チャコールスレート」を再入荷しました。"}',4.8,840),
('kanso-notes','app','Kanso Notes','思考を妨げない余白重視のアウトライナー','書くことだけに集中できるよう設計されたミニマルなノートアプリ。iCloudによる瞬時の同期とMarkdownショートカットに対応します。','仕事効率化','Minimal Works','28.5 MB','4+','入手','無料',false,null,array['高速iCloudリアルタイム同期','Markdown & 数式プレビュー','集中フォーカスモード'],'bg-gradient-to-br from-amber-400 to-orange-500','from-amber-400 to-orange-500',array['from-amber-400 to-orange-500','from-orange-500 to-rose-500'],'{"version":"バージョン 3.1.0","date":"3日前","notes":"・フォルダ間のドラッグ＆ドロップ並べ替えに対応しました。"}',4.8,562),
('monolith-chess','game','Monolith Tactics','建築美と戦略が交差するミニマル・パズル','幾何学的な建築空間を回転させ、光のルートを繋ぐ思考型パズルゲーム。120以上のステージを収録。','ボード / パズル','Geometry Studio','310 MB','4+','¥480','買い切り · 広告なし',false,null,array['全120ステージ収録','広告・追加課金なし','オフラインプレイ対応'],'bg-gradient-to-br from-emerald-400 to-teal-600','from-emerald-500 to-teal-700',array['from-emerald-500 to-teal-700','from-teal-600 to-cyan-800'],'{"version":"バージョン 1.4.0","date":"1週間前","notes":"・エクストラチャプター「白亜の迷宮」を追加しました。"}',4.9,910),
('sonic-flow','app','Flowstate Sound','雨音とアンビエントで深い集中状態へ','生体リズムに合わせて自動生成されるサウンドスケープ。ポモドーロタイマーと連携します。','ヘルスケア / 集中','Aural Wellness','42.0 MB','4+','入手','App内課金あり',false,null,array['AI環境音ジェネレーター','スマートタイマー連携','スリープフェードアウト機能'],'bg-gradient-to-br from-cyan-500 to-blue-600','from-cyan-500 to-blue-700',array['from-cyan-500 to-blue-700','from-blue-600 to-indigo-800'],'{"version":"バージョン 2.0.5","date":"4日前","notes":"・新しい環境音を追加しました。"}',4.7,430),
('prism-drift','game','Prism Drift','ネオンの軌跡を描くハイスピード・グライダー','60fps/120fpsの滑らかなフレームレートで駆け抜けるミニマル・レーシング。','レーシング / アクション','Vector Pulse','520 MB','4+','入手','無料',false,null,array['直感的なワンフィンガー操作','グローバルランキング対応','ダイナミックシンセBGM'],'bg-gradient-to-br from-rose-500 to-pink-600','from-rose-500 to-pink-700',array['from-rose-500 to-pink-700','from-fuchsia-600 to-purple-800'],'{"version":"バージョン 1.6.1","date":"6日前","notes":"・ウィークリータイムアタックモードを追加しました。"}',4.8,1850),
('aluminum-stand','product','Aero Aluminum Stand','精密削り出しアルミニウム製デバイススタンド','航空機グレードのアルミブロックから削り出した一体成型スタンド。アノダイズド仕上げ。','デスクギア','Anodize Lab','380 g','保証2年','¥9,400','在庫あり',false,null,array['CNC精密削り出しアルミ','無段階ヒンジ角度調整','ケーブルマネジメントホール'],'bg-gradient-to-br from-zinc-400 to-neutral-600','from-zinc-500 to-neutral-700',array['from-zinc-500 to-neutral-700','from-slate-600 to-zinc-800'],'{"version":"Rev.2 モデル","date":"2週間前","notes":"・底面のシリコンラバーのグリップ力を強化しました。"}',4.9,1120),
('mag-power-slim','product','MagSlim 5000','厚さわずか7.8mmの超薄型マグネットバッテリー','ポケットに入れても気にならない超薄型設計。マットなガラスパネルとアルミフレームを採用。','モバイルバッテリー','Volt Minimal','7.8 mm薄型','PSE認証','¥7,980','送料無料',false,null,array['厚さ7.8mmウルトラスリム設計','強力マグネット吸着ワイヤレス','USB-C急速入出力対応'],'bg-gradient-to-br from-slate-700 to-slate-900','from-slate-700 to-slate-900',array['from-slate-700 to-slate-900','from-zinc-700 to-neutral-900'],'{"version":"2026 改良版","date":"1週間前","notes":"・充電時の発熱を抑えるグラフェン放熱シートを内蔵しました。"}',4.7,650);

-- ===== 管理者の設定 =====
-- Authentication で管理者ユーザーを作成後に実行:
-- update profiles set is_admin = true where id = '<管理者のUUID>';
