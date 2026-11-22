import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/endpoints';
import { injectBridge, BRIDGE_CHANNEL } from '../bridge/appBridge';
import { AwardModal } from '../features/award/AwardModal';
import { ConsentSheet } from '../features/consent/ConsentSheet';
import { PaySheet, type PayOutcome, type PayRequest } from '../features/payment/PaySheet';
import { FloatingMenu } from '../features/run/FloatingMenu';
import { handleHostRequest, type HostReply } from '../features/run/hostHandler';
import type { AccessResponse } from '../types/api';
import { navigate } from '../lib/router';

interface RunPageProps {
  appId: string;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'consent'; access: AccessResponse }
  | { kind: 'ready'; srcDoc: string }
  | { kind: 'error'; message: string };

export function RunPage({ appId }: RunPageProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [access, setAccess] = useState<AccessResponse | null>(null);
  const [payRequest, setPayRequest] = useState<PayRequest | null>(null);
  const [award, setAward] = useState<{ amount: number; reason: string } | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const payResolver = useRef<((outcome: PayOutcome) => void) | null>(null);

  const refreshAccess = useCallback(async (): Promise<AccessResponse | null> => {
    try {
      const next = await api.access(appId);
      setAccess(next);
      return next;
    } catch {
      setAccess(null);
      return null;
    }
  }, [appId]);

  const openApp = useCallback(async () => {
    try {
      const html = await api.appHtml(appId);
      setPhase({ kind: 'ready', srcDoc: injectBridge(html) });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'このアプリは開けません。' });
    }
  }, [appId]);

  // 起動：許可が必要なら許可の確認を出し、そうでなければアプリを開く
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const a = await api.access(appId);
        if (cancelled) return;
        setAccess(a);
        if (a.needsConsent && !a.consented) setPhase({ kind: 'consent', access: a });
        else await openApp();
      } catch (err) {
        if (cancelled) return;
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'このアプリは開けません（入手していない、または準備中です）' });
      }
    })();
    return () => { cancelled = true; };
  }, [appId, openApp]);

  // 支払い確認は一つだけ。結果は呼び出し元（アプリ）へ返す
  const requestPay = useCallback((req: PayRequest) => {
    if (payResolver.current) return Promise.resolve<HostReply>({ ok: false, code: 'busy', error: 'ほかの支払いの確認が出ています。' });
    return new Promise<HostReply>((resolve) => {
      payResolver.current = (outcome) => {
        payResolver.current = null;
        setPayRequest(null);
        resolve(outcome.ok ? { ok: true, data: { charged: outcome.charged } } : { ok: false, code: outcome.code, error: outcome.error, points: outcome.points });
      };
      setPayRequest(req);
    });
  }, []);

  const finishPay = useCallback((outcome: PayOutcome) => {
    payResolver.current?.(outcome);
  }, []);

  // アプリからの依頼を受け取る（iframe の中から来たものだけ）
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as { channel?: string; id?: string; type?: string; data?: Record<string, unknown> } | null;
      if (!m || m.channel !== BRIDGE_CHANNEL || typeof m.id !== 'string' || typeof m.type !== 'string') return;
      handleHostRequest(m.type, m.data ?? {}, {
        appId,
        refreshAccess,
        requestPay,
        showAward: (amount, reason) => setAward({ amount, reason }),
      })
        .catch((err: unknown) => ({ ok: false as const, code: 'error', error: String(err instanceof Error ? err.message : err) }))
        .then((reply) => {
          frame.contentWindow?.postMessage({ channel: BRIDGE_CHANNEL, id: m.id, ...reply }, '*');
        });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [appId, refreshAccess, requestPay]);

  // Escape：支払い中は閉じない
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (payRequest) { finishPay({ ok: false, code: 'cancelled', error: 'お支払いを取り消しました。' }); return; }
      if (award) { setAward(null); return; }
      if (exitOpen) setExitOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payRequest, award, exitOpen, finishPay]);

  return (
    <div className="run">
      {phase.kind === 'ready' ? (
        <iframe ref={frameRef} className="run-frame" title="アプリ" sandbox="allow-scripts" allow="fullscreen; clipboard-write" srcDoc={phase.srcDoc} />
      ) : null}

      {phase.kind === 'loading' ? <div className="center">読み込み中…</div> : null}

      {phase.kind === 'error' ? (
        <div className="center">
          <p>{phase.message}</p>
          <button className="btn sec" type="button" onClick={() => navigate('/')}>ホームに戻る</button>
        </div>
      ) : null}

      {phase.kind === 'consent' ? (
        <ConsentSheet
          appId={appId}
          description={access?.grant ? `このアプリは、ポイントを配ることがあります（あと ${access.grant.remaining.toLocaleString('ja-JP')}pt まで）。` : 'あなたの表示名と、仙人アカウントの連携の有無を、このアプリに渡します。'}
          onAllowed={async () => { await refreshAccess(); await openApp(); }}
          onDecline={() => navigate('/')}
        />
      ) : null}

      {payRequest ? (
        <PaySheet appId={appId} request={payRequest} onFinish={finishPay} />
      ) : null}

      {award ? (
        <AwardModal amount={award.amount} reason={award.reason} onClose={() => setAward(null)} />
      ) : null}

      <FloatingMenu onOpen={() => setExitOpen(true)} />

      {exitOpen ? (
        <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="アプリの終了" onClick={(e) => { if (e.target === e.currentTarget) setExitOpen(false); }}>
          <div className="sheet">
            <h3>アプリを終了しますか？</h3>
            <p>保存されていないデータは失われる場合があります。</p>
            <div className="row">
              <button className="btn sec" type="button" onClick={() => setExitOpen(false)}>続ける</button>
              <button className="btn danger" type="button" onClick={() => navigate('/')}>終了する</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
