import { Sheet } from '../../components/Sheet';
import { formatPoints } from '../../lib/format';

interface AwardModalProps {
  amount: number;
  reason: string;
  onClose: () => void;
}

export function AwardModal({ amount, reason, onClose }: AwardModalProps) {
  return (
    <Sheet open label="ポイント獲得" onBackdropClick={onClose}>
      <div className="award-icon" aria-hidden="true">★</div>
      <h3>ポイントを獲得しました！</h3>
      <div className="award-amt">+{formatPoints(amount)}</div>
      {reason.trim() ? <p className="award-reason">{reason.trim()}</p> : null}
      <div className="row">
        <button className="btn pri" type="button" onClick={onClose}>OK</button>
      </div>
    </Sheet>
  );
}
