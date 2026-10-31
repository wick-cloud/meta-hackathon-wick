import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from 'react';
import { ArrowLeft, ArrowRight, ArrowLeftRight } from 'lucide-react';
import './table.css';

/** A keyboard-accessible viewport shared by every buyer, provider and admin table. */
export function TableViewport({
  label,
  minWidth = 680,
  className = '',
  children,
  onScroll,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label: string; minWidth?: number }) {
  const viewport = useRef<HTMLDivElement>(null),
    hintId = useId();
  const [scroll, setScroll] = useState({ overflow: false, start: true, end: true });
  const measure = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { overflow: max > 1, start: el.scrollLeft <= 1, end: el.scrollLeft >= max - 1 };
    setScroll((old) =>
      old.overflow === next.overflow && old.start === next.start && old.end === next.end
        ? old
        : next,
    );
  }, []);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [measure]);
  function move(direction: number) {
    const el = viewport.current;
    if (!el) return;
    el.scrollBy({
      left: direction * el.clientWidth * 0.75,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
  return (
    <div
      className="data-table-frame"
      style={{ '--table-min-width': `${minWidth}px` } as CSSProperties}
    >
      <div
        ref={viewport}
        className={`data-table-scroll ${className}`}
        tabIndex={0}
        role="region"
        aria-label={label}
        aria-describedby={scroll.overflow ? hintId : undefined}
        onScroll={(event) => {
          measure();
          onScroll?.(event);
        }}
        {...props}
      >
        {children}
      </div>
      {scroll.overflow && (
        <div className="data-table-navigation">
          <span id={hintId}>
            <ArrowLeftRight size={13} aria-hidden="true" /> Scroll to see all columns
          </span>
          <div>
            <button
              type="button"
              disabled={scroll.start}
              onClick={() => move(-1)}
              aria-label={`${label}: scroll left`}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              disabled={scroll.end}
              onClick={() => move(1)}
              aria-label={`${label}: scroll right`}
            >
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
