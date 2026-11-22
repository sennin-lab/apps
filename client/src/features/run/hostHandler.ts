// アプリ（iframe）からの依頼を、ホーム側で処理する。返り値はアプリへ返す応答
import { api } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import type { AccessResponse } from '../../types/api';

export type HostReply =
  | { ok: true; data?: unknown }
  | { ok: false; code: string; error: string; points?: number };

export interface HostContext {
  appId: string;
  refreshAccess: () => Promise<AccessResponse | null>;
  requestPay: (req: { amount: number; title: string; requestId: string }) => Promise<HostReply>;
  showAward: (amount: number, reason: string) => void;
}

const consentText = (access: AccessResponse | null) =>
  access?.needsConsent
    ? 'ユーザー情報の共有を許可していません。アプリを開き直すと、確認が出ます。'
    : 'このアプリでは、ユーザー情報は使えません。';

export async function handleHostRequest(type: string, data: Record<string, unknown>, ctx: HostContext): Promise<HostReply> {
  switch (type) {
    case 'account': {
      const access = await ctx.refreshAccess();
      if (!access) return { ok: false, code: 'error', error: 'アカウント情報を取得できませんでした。' };
      if (!access.consented) return { ok: false, code: 'not_consented', error: consentText(access) };
      return { ok: true, data: { sub: access.user?.sub, name: access.user?.name, sennin: access.sennin, grant: access.grant } };
    }

    case 'consent':
      return ctx.refreshAccess().then((access) =>
        access?.consented
          ? { ok: true, data: { consented: true } }
          : { ok: false, code: 'not_consented', error: consentText(access) },
      );

    case 'charge': {
      const amount = data.amount;
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      const requestId = typeof data.requestId === 'string' ? data.requestId : '';
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) {
        return { ok: false, code: 'invalid', error: '支払うポイントは 1 以上の整数で指定してください。' };
      }
      if (!title) return { ok: false, code: 'invalid', error: '品名を指定してください。' };
      return ctx.requestPay({ amount, title, requestId });
    }

    case 'award': {
      const access = await ctx.refreshAccess();
      if (!access?.consented) return { ok: false, code: 'not_consented', error: consentText(access) };
      const amount = Number(data.amount);
      const reason = typeof data.reason === 'string' ? data.reason : '';
      const requestId = typeof data.requestId === 'string' ? data.requestId : '';
      try {
        const res = await api.award(ctx.appId, { amount, reason, requestId });
        await ctx.refreshAccess();
        ctx.showAward(amount, reason);
        return { ok: true, data: res };
      } catch (err) {
        if (err instanceof ApiError) {
          return { ok: false, code: err.code ?? 'error', error: err.message, points: err.points };
        }
        return { ok: false, code: 'error', error: 'ポイントを配れませんでした。' };
      }
    }

    default:
      return { ok: false, code: 'unknown_request', error: '対応していない依頼です。' };
  }
}
