import type { ReactNode } from 'react';

interface SheetProps {
  open: boolean;
  onBackdropClick?: () => void;
  children: ReactNode;
  label: string;
}

// 下から出てくる確認パネルの共通部品。背景タップで閉じられる（onBackdropClick があるとき）
export function Sheet({ open, onBackdropClick, children, label }: SheetProps) {
  if (!open) return null;
  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => { if (e.target === e.currentTarget) onBackdropClick?.(); }}
    >
      <div className="sheet">{children}</div>
    </div>
  );
}
