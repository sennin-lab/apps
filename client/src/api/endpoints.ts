import { request } from './client';
import type {
  AccessResponse,
  AwardResult,
  ChargeResult,
  ConsentResponse,
  Me,
  PurchaseResult,
  StoreBootstrap,
} from '../types/api';

export const api = {
  me: () => request<{ me: Me | null }>('/api/me'),
  bootstrap: () => request<StoreBootstrap>('/api/store/bootstrap'),
  purchase: (itemId: string) =>
    request<PurchaseResult>('/api/purchase', { method: 'POST', body: { item_id: itemId } }),

  access: (appId: string) => request<AccessResponse>(`/api/apps/${enc(appId)}/access`),
  consent: (appId: string) =>
    request<ConsentResponse>(`/api/apps/${enc(appId)}/consent`, { method: 'POST', body: {} }),
  appHtml: async (appId: string): Promise<string> => {
    const res = await fetch(`/api/apps/${enc(appId)}/html`, { credentials: 'same-origin' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? 'このアプリは開けません（入手していない、または準備中です）');
    }
    return res.text();
  },
  charge: (appId: string, input: { amount: number; title: string; requestId: string }) =>
    request<ChargeResult>(`/api/apps/${enc(appId)}/charge`, { method: 'POST', body: input }),
  award: (appId: string, input: { amount: number; reason: string; requestId: string }) =>
    request<AwardResult>(`/api/apps/${enc(appId)}/award`, { method: 'POST', body: input }),
};

const enc = (value: string) => encodeURIComponent(value);
