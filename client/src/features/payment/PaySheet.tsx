import { useEffect, useState } from 'react';
import { api } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { Sheet } from '../../components/Sheet';
import { formatPoints } from '../../lib/format';

export interface PayRequest {
  amount: number;
  title: string;
  requestId: string;
}

export type PayOutcome =
  | { ok: true; charged: number }
  | { ok: false; code: string; error: string; points?: number };

interface PaySheetProps {
  appId: string;
  request: PayRequest;
  onFinish: (outcome: PayOutcome) => void;
}

// 支払い確認と完了表示。完了を出すのは、サーバーが「確定した」と返し、金額も一致したときだけ
export function PaySheet({ appId, request, onFinish }: PaySheetProps) {
  const [phase, setPhase] = useState<'confirm' | 'paying' | 'done'>('confirm');
  const [error, setError] = useState('');

  useEffect(() => {
    if (phase !== 'done') return;
    const timer = window.setTimeout(() => onFinish({ ok: true, charged: request.amount }), 1250);
    return () => window.clearTimeout(timer);
  }, [phase, request.amount, onFinish]);

  const pay = async () => {
    setPhase('paying');
    setError('');
    try {
      const res = await api.charge(appId, request);
      if (res.ok === true && Number(res.charged) === request.amount) {
        setPhase('done');
        return;
      }
      // HTTP は成功だが、確定の内容が合わない。同じ requestId で押し直せるように残す
      setError('支払いを確認できませんでした。もう一度「支払う」を押してください。');
      setPhase('confirm');
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      if (e && (e.status === 0 || e.status === 503)) {
        // 結果が分からない失敗。同じ requestId で押し直せる
        setError(e.message);
        setPhase('confirm');
        return;
      }
      onFinish({
        ok: false,
        code: e?.code ?? 'error',
        error: e?.message ?? '支払えませんでした。',
        points: e?.points,
      });
    }
  };

  const busy = phase !== 'confirm';

  return (
    <Sheet open label="ポイントの支払い" onBackdropClick={busy ? undefined : () => onFinish({ ok: false, code: 'cancelled', error: 'お支払いを取り消しました。' })}>
      {phase === 'done' ? (
        <div className="pay-done">
          <div className="check-circle" aria-hidden="true" />
          <div className="pay-done-title">お支払い完了</div>
          <div className="pay-done-sub">{formatPoints(request.amount)} 支払いました</div>
        </div>
      ) : (
        <>
          <div className="sheet-header">
            <h3>ポイントを支払いますか？</h3>
            <span className="brand-badge">SenninPay</span>
          </div>
          <div className="pay-box">
            <div className="pay-item-name">{request.title}</div>
            <div className="amt">{formatPoints(request.amount)}</div>
          </div>
          <p>仙人ポイント残高から引き落とされます。</p>
          {error ? <div className="err">{error}</div> : null}
          <div className="row">
            <button
              className="btn sec"
              type="button"
              disabled={busy}
              onClick={() => onFinish({ ok: false, code: 'cancelled', error: 'お支払いを取り消しました。' })}
            >
              キャンセル
            </button>
            <button className="btn pri" type="button" disabled={busy} onClick={pay}>
              {phase === 'paying' ? '処理中…' : '支払う'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
