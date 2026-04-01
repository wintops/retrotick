import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';

interface Rect { x: number; y: number; w: number; h: number }

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Rubber band (lasso) selection hook.
 * Returns handlers to attach to the container and the rect to render.
 * `onSelectionChange` is called with the set of storePaths whose icons intersect the rubber band.
 * `didDrag` is true briefly after a drag ends, to suppress the click event.
 */
export function useRubberBand(
  containerRef: RefObject<HTMLElement>,
  onSelectionChange: (names: Set<string>) => void,
) {
  const [rect, setRect] = useState<Rect | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const active = useRef(false);
  const didDragRef = useRef(false);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-desktop-icon]')) return;
    const container = containerRef.current;
    if (!container) return;
    const cr = container.getBoundingClientRect();
    startPos.current = { x: e.clientX - cr.left + container.scrollLeft, y: e.clientY - cr.top + container.scrollTop };
    active.current = false;
    didDragRef.current = false;
  }, [containerRef]);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!startPos.current) return;
      const container = containerRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const curX = e.clientX - cr.left + container.scrollLeft;
      const curY = e.clientY - cr.top + container.scrollTop;
      const dx = curX - startPos.current.x;
      const dy = curY - startPos.current.y;
      if (!active.current && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      active.current = true;

      const rx = Math.min(startPos.current.x, curX);
      const ry = Math.min(startPos.current.y, curY);
      const rw = Math.abs(dx);
      const rh = Math.abs(dy);
      const band: Rect = { x: rx, y: ry, w: rw, h: rh };
      setRect(band);

      const icons = container.querySelectorAll('[data-store-path]');
      const selected = new Set<string>();
      for (const icon of icons) {
        const ir = icon.getBoundingClientRect();
        const iconRect: Rect = {
          x: ir.left - cr.left + container.scrollLeft,
          y: ir.top - cr.top + container.scrollTop,
          w: ir.width,
          h: ir.height,
        };
        if (rectsIntersect(band, iconRect)) {
          const path = icon.getAttribute('data-store-path');
          if (path) selected.add(path);
        }
      }
      onSelectionChange(selected);
    };

    const onPointerUp = () => {
      if (active.current) {
        didDragRef.current = true;
        active.current = false;
        setRect(null);
      }
      startPos.current = null;
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, [containerRef, onSelectionChange]);

  /** Call this in onClick to check if the click was a rubber band end (and should be suppressed). Resets the flag. */
  const consumeDrag = useCallback(() => {
    if (didDragRef.current) { didDragRef.current = false; return true; }
    return false;
  }, []);

  return { rect, onPointerDown, consumeDrag };
}
