import { useState } from 'react';
import { api } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { Sheet } from '../../components/Sheet';

interface ConsentSheetProps {
  appId: string;
  description: string;
  onAllowed: () => void;
  onDecline: () => void;
}

export function ConsentSheet({ appId, description, onAllowed, onDecline }: ConsentSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const allow = async () => {
    setBusy(true);
    setError('');
    try {
      await api.consent(appId);
      onAllowed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '許可できませんでした。もう一度お試しください。');
      setBusy(false);
    }
  };

  return (
    <Sheet open label="情報の許可" >
      <h3>アプリに情報を渡しますか？</h3>
      <p>{description}</p>
      <p>許可しないと、このアプリは開けません。許可したあとも、いつでも取り消せます。</p>
      {error ? <div className="err">{error}</div> : null}
      <div className="row">
        <button className="btn sec" type="button" onClick={onDecline} disabled={busy}>ホームに戻る</button>
        <button className="btn pri" type="button" onClick={allow} disabled={busy}>許可する</button>
      </div>
    </Sheet>
  );
}
