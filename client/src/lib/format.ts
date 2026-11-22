const ja = new Intl.NumberFormat('ja-JP');

export const formatPoints = (value: number): string => `${ja.format(value)} pt`;

export const formatCount = (value: number): string => ja.format(value);

// 支払いの押し直しで同じ金額・品名を使うための requestId を作る
export const makeRequestId = (): string =>
  `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
