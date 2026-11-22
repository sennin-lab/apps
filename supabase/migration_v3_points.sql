-- ===== store-service v3：アプリ内課金（確認つき支払い）・ポイント配布・作者への売上（sorachat と同じ仕組み） =====
-- 既存の利用者・購入・アプリのデータは消えません。何度実行しても安全です。
-- 新規セットアップは schema.sql → このファイルの順に実行してください。
--
-- 変更点:
--  ・仙人アカウントの更新トークンは、暗号化して sennin_links に保存する（セッションからは外す）
--  ・アプリ内課金は SKU ではなく「金額と品名を、利用者が確認画面で同意して払う」方式に変わる（app_charges）
--  ・ポイント配布は、管理者が上限を決める（app_grants）。利用者の許可は app_consents
--  ・購入・支払いのたびに作者への売上（app_sales）を作り、全額を払う（払えないものは保留して再送）
--  ・認定開発者（creators.certified）は、1回に払わせられる上限が高い
--
-- 注意: 既存の利用者は、この変更のあと一度ログインし直すと、ポイントの連携（sennin_links）が作られます。

-- ===== 0. アプリ本体（HTML）。migration_app_sources.sql の内容 =====
create table if not exists app_sources (
  item_id text primary key references items(id) on delete cascade,
  html text not null,
  updated_at timestamptz not null default now()
);
alter table app_sources enable row level security;

-- ===== 1. 仙人アカウントの連携（更新トークンは暗号化して保存） =====
create table if not exists sennin_links (
  sub text primary key references accounts(sub) on delete cascade,
  refresh_token_enc text not null,
  updated_at timestamptz not null default now()
);
alter table sennin_links enable row level security;

-- セッションにはログインの識別だけを残す（トークンの平文は持たない）
alter table sennin_sessions drop column if exists access_token;
alter table sennin_sessions drop column if exists access_expires_at;
alter table sennin_sessions drop column if exists refresh_token;

-- ===== 2. 配布の上限（管理者が決める） =====
create table if not exists app_grants (
  item_id text primary key references items(id) on delete cascade,
  max_points integer not null default 0 check (max_points >= 0),
  used_points integer not null default 0 check (used_points >= 0),
  per_call_max integer not null default 500 check (per_call_max >= 1),
  per_user_minute_max integer not null default 0 check (per_user_minute_max >= 0),
  active boolean not null default false,
  updated_at timestamptz not null default now(),
  check (used_points <= max_points)
);
alter table app_grants enable row level security;

-- 利用者が「アカウント情報を、このアプリに渡してよい」と許可した記録
create table if not exists app_consents (
  user_sub text not null references accounts(sub) on delete cascade,
  item_id text not null references items(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (user_sub, item_id)
);
alter table app_consents enable row level security;

-- 配布の記録（request_id で同じ配布を二重に加算しない）
create table if not exists app_awards (
  id uuid primary key default gen_random_uuid(),
  user_sub text not null references accounts(sub) on delete cascade,
  item_id text not null references items(id) on delete cascade,
  request_id text not null,
  points integer not null check (points > 0),
  status text not null default 'reserved' check (status in ('reserved', 'done', 'failed')),
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_sub, item_id, request_id)
);
alter table app_awards enable row level security;

-- ===== 3. アプリ内課金（確認画面で利用者が同意した支払い） =====
create table if not exists app_charges (
  id uuid primary key default gen_random_uuid(),
  user_sub text not null references accounts(sub) on delete cascade,
  item_id text not null references items(id) on delete cascade,
  request_id text not null,
  amount integer not null check (amount > 0),
  title text not null default '',
  status text not null default 'reserved' check (status in ('reserved', 'done', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_sub, item_id, request_id)
);
alter table app_charges enable row level security;

-- ===== 4. 売上（作者へ払う。購入か支払いのどちらか1つに紐づく） =====
create table if not exists app_sales (
  id uuid primary key default gen_random_uuid(),
  payee_sub text not null,
  item_id text not null,
  purchase_id uuid unique references purchases(id) on delete cascade,
  charge_id uuid unique references app_charges(id) on delete cascade,
  amount integer not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  ledger_id text,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (purchase_id is not null or charge_id is not null)
);
create index if not exists app_sales_payee_idx on app_sales (payee_sub, status);
create index if not exists app_sales_item_idx on app_sales (item_id);
alter table app_sales enable row level security;

-- ===== 5. 認定開発者 =====
create table if not exists creators (
  sub text primary key references accounts(sub) on delete cascade,
  certified boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table creators enable row level security;

-- ===== 6. 配布の枠の確保と、結果の確定（sorachat の sc_extension_reserve / settle と同じ考え方） =====
-- 枠を確保する。同じ request_id が既にあれば、その今の状態を返す（押し直しても二重に枠を使わない）。
-- 枠が足りなければ 'exhausted'、1分あたりの上限を超えれば 'minute_exhausted'、許可がなければ 'inactive'。
create or replace function app_award_reserve(
  p_user text,
  p_item text,
  p_request text,
  p_points integer,
  p_reason text
) returns jsonb
language plpgsql
as $$
declare
  existing record;
  grant_row record;
  minute_used integer;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('app-award:' || p_item));

  select id, status, points into existing
  from app_awards
  where user_sub = p_user and item_id = p_item and request_id = p_request;
  if found then
    return jsonb_build_object('result', 'exists', 'id', existing.id, 'status', existing.status, 'points', existing.points);
  end if;

  select max_points, used_points, active, per_user_minute_max into grant_row
  from app_grants
  where item_id = p_item;
  if not found or not grant_row.active then
    return jsonb_build_object('result', 'inactive');
  end if;
  if grant_row.used_points + p_points > grant_row.max_points then
    return jsonb_build_object('result', 'exhausted', 'remaining', grant_row.max_points - grant_row.used_points);
  end if;

  -- 1人が1分間に受け取れる上限（0 は制限なし）。確保中・完了の配布だけを数える
  if grant_row.per_user_minute_max > 0 then
    select coalesce(sum(points), 0) into minute_used
    from app_awards
    where user_sub = p_user and item_id = p_item
      and status in ('reserved', 'done')
      and created_at > now() - interval '1 minute';
    if minute_used + p_points > grant_row.per_user_minute_max then
      return jsonb_build_object(
        'result', 'minute_exhausted',
        'limit', grant_row.per_user_minute_max,
        'remaining', greatest(grant_row.per_user_minute_max - minute_used, 0)
      );
    end if;
  end if;

  update app_grants
  set used_points = used_points + p_points, updated_at = now()
  where item_id = p_item;

  insert into app_awards (user_sub, item_id, request_id, points, status, reason)
  values (p_user, p_item, p_request, p_points, 'reserved', coalesce(p_reason, ''))
  returning id into new_id;

  return jsonb_build_object('result', 'reserved', 'id', new_id, 'status', 'reserved', 'points', p_points);
end;
$$;

-- 配布の結果を記録する。failed のときは確保した枠を戻す（1回だけ）。reserved 以外からは変えない。
create or replace function app_award_settle(p_award uuid, p_status text)
returns text
language plpgsql
as $$
declare
  row_data record;
begin
  if p_status not in ('done', 'failed') then
    raise exception 'invalid status: %', p_status;
  end if;

  select id, item_id, points, status into row_data
  from app_awards
  where id = p_award
  for update;
  if not found then
    return 'missing';
  end if;
  if row_data.status <> 'reserved' then
    return row_data.status;
  end if;

  update app_awards
  set status = p_status, updated_at = now()
  where id = p_award;

  if p_status = 'failed' then
    update app_grants
    set used_points = greatest(used_points - row_data.points, 0), updated_at = now()
    where item_id = row_data.item_id;
  end if;

  return p_status;
end;
$$;
