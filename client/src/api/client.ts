import type { ApiErrorBody } from '../types/api';

// APIの失敗を型付きで扱うための例外。画面にはこの message をそのまま出せる
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly points: number | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.points = body.points;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

// 応答が HTTP 成功かつ ok !== false のときだけ成功とみなす（支払いの誤表示を防ぐため）
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
  };
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, { ok: false, error: '通信に失敗しました。時間をおいてお試しください。', code: 'network' });
  }

  const body = (await res.json().catch(() => ({}))) as ApiErrorBody & Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new ApiError(res.status, body);
  }
  return body as T;
}
