-- ===== senninstudio / store-service v2（仙人アカウント版） =====
-- 注意: 旧版のテーブルを削除して作り直します。既存データは消えます。
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_user();
drop table if exists iap_products, purchases, library, reviews, codes, items, profiles, sennin_sessions, accounts cascade;

-- ===== アカウント（仙人アカウントの sub で識別） =====
create table accounts (
  sub text primary key,
  name text,
  email text,
  role text not null default 'user' check (role in ('user', 'developer')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- 仙人アカウントのセッション（トークンはサーバーのみが読む）
create table sennin_sessions (
  sid_hash text primary key,
  sub text not null references accounts(sub) on delete cascade,
  name text,
  email text,
  access_token text not null,
  access_expires_at timestamptz not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ===== 作品（アプリ・ゲーム・商品） =====
create table items (
  id text primary key,
  owner_sub text references accounts(sub) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'in_review', 'published', 'suspended')),
  type text not null default 'app' check (type in ('app', 'game', 'product')),
  title text not null,
  subtitle text,
  description text,
  category_label text,
  developer text,
  size text,
  age_rating text,
  price_points integer not null default 0 check (price_points >= 0),
  sub_price_note text,
  trending boolean not null default false,
  featured_badge text,
  highlights text[] not null default '{}',
  preview_images text[] not null default '{}',
  icon_url text,
  thumbnail_url text,
  icon_bg text,
  gradient text,
  whats_new jsonb,
  rating numeric(2,1) not null default 0,
  reviews_count int not null default 0,
  launch_url text,
  open_mode text not null default 'iframe' check (open_mode in ('iframe', 'new_tab')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index items_status_idx on items(status);
create index items_owner_idx on items(owner_sub);

-- アプリ本体（HTML）。公開APIには出さず、所有者・購入者だけが取得する
create table app_sources (
  item_id text primary key references items(id) on delete cascade,
  html text not null,
  updated_at timestamptz not null default now()
);

-- アプリ内課金の商品（SKU単位・仙人ポイント）
create table iap_products (
  sku text primary key,
  item_id text not null references items(id) on delete cascade,
  name text not null,
  price_points integer not null check (price_points > 0),
  consumable boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 入手済み（無料・購入・コード引き換え）
create table library (
  user_sub text not null references accounts(sub) on delete cascade,
  item_id text not null references items(id) on delete cascade,
  acquired_at timestamptz not null default now(),
  primary key (user_sub, item_id)
);

-- 購入記録（ポイント引き落とし単位。idempotency_key = purchase-<id>）
create table purchases (
  id uuid primary key default gen_random_uuid(),
  user_sub text not null references accounts(sub) on delete cascade,
  item_id text not null,
  sku text,
  price_points integer not null check (price_points >= 0),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index purchases_user_idx on purchases(user_sub, item_id);

-- レビュー（入手済みの人のみ投稿可。作者は1作品1件）
create table reviews (
  id uuid primary key default gen_random_uuid(),
  item_id text not null references items(id) on delete cascade,
  user_sub text not null references accounts(sub) on delete cascade,
  author_name text,
  rating int not null check (rating between 1 and 5),
  title text,
  body text,
  developer_reply text,
  developer_reply_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, user_sub)
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

-- ===== RLS =====
-- すべてサーバー(service_role)経由でアクセスするため、公開ポリシーは作らない
alter table accounts enable row level security;
alter table sennin_sessions enable row level security;
alter table items enable row level security;
alter table iap_products enable row level security;
alter table library enable row level security;
alter table purchases enable row level security;
alter table reviews enable row level security;
alter table codes enable row level security;
alter table app_sources enable row level security;
