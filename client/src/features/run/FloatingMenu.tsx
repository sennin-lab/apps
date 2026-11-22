import { useRef, useState } from 'react';

interface FloatingMenuProps {
  onOpen: () => void;
}

// ドラッグで動かせるメニューボタン。ドラッグした直後の「タップ」は開かない
export function FloatingMenu({ onOpen }: FloatingMenuProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    drag.current = { startX: e.clientX, startY: e.clientY, originX: rect.left, originY: rect.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
    const maxX = window.innerWidth - e.currentTarget.offsetWidth - 10;
    const maxY = window.innerHeight - e.currentTarget.offsetHeight - 10;
    setPos({
      x: Math.max(10, Math.min(d.originX + dx, maxX)),
      y: Math.max(10, Math.min(d.originY + dy, maxY)),
    });
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onOpen();
  };

  return (
    <button
      type="button"
      className="menu-fab"
      aria-label="メニューを開く"
      style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { drag.current = null; }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="2.2" />
        <circle cx="12" cy="12" r="2.2" />
        <circle cx="19" cy="12" r="2.2" />
      </svg>
    </button>
  );
}
