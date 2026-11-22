// サーバー（server.js）が返す形。フィールド名はサーバーの応答にそろえる（snake_case）

export interface Me {
  sub: string;
  name: string | null;
  email: string | null;
  role: 'admin' | 'developer' | 'user' | string;
  linked: boolean;
  points: number | null;
}

export interface StoreItem {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  category_label: string | null;
  developer: string | null;
  size: string | null;
  age_rating: string | null;
  price_points: number;
  sub_price_note: string | null;
  highlights: string[] | null;
  gradient: string | null;
  icon_bg: string | null;
  icon_url: string | null;
  thumbnail_url: string | null;
  preview_images: string[] | null;
  whats_new: string | null;
  rating: number | null;
  reviews_count: number | null;
  status: 'draft' | 'pending' | 'published' | 'suspended' | string;
  has_app: boolean;
  created_at: string;
}

export interface StoreBootstrap {
  me: Me | null;
  items: StoreItem[];
  library: string[];
}

export interface PurchaseResult {
  ok: true;
  already?: boolean;
  free?: boolean;
  points?: number;
}

export interface ChargeResult {
  ok: true;
  charged: number;
  replayed: boolean;
  points: number | null;
}

export interface ApiErrorBody {
  ok?: false;
  error?: string;
  code?: string;
  points?: number;
}

export interface AccessResponse {
  consented: boolean;
  needsConsent: boolean;
  user?: { sub: string; name: string | null };
  sennin?: unknown;
  grant?: { remaining: number } | null;
}

export interface ConsentResponse {
  ok: true;
}

export interface AwardResult {
  ok: true;
  awarded: number;
  replayed: boolean;
  points: number | null;
}
