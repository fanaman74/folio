import { useEffect, useRef } from 'react';

const width = 1200;
const height = 660;
const columns = 12;
const rows = 7;
const vertices = Array.from({ length: (columns + 1) * (rows + 1) }, (_, index) => {
  const column = index % (columns + 1);
  const row = Math.floor(index / (columns + 1));
  return {
    x: column * width / columns + (column > 0 && column < columns ? Math.sin(index * 13.7) * 28 : 0),
    y: row * height / rows + (row > 0 && row < rows ? Math.cos(index * 7.3) * 24 : 0),
  };
});
const facets = Array.from({ length: rows * columns }, (_, index) => {
  const topLeft = Math.floor(index / columns) * (columns + 1) + index % columns;
  const topRight = topLeft + 1;
  const bottomLeft = topLeft + columns + 1;
  const bottomRight = bottomLeft + 1;
  return index % 2
    ? [[topLeft, topRight, bottomLeft], [topRight, bottomRight, bottomLeft]]
    : [[topLeft, topRight, bottomRight], [topLeft, bottomRight, bottomLeft]];
}).flat();
const pathFor = (indices: number[], points: typeof vertices) => indices.map((index, position) => `${position ? 'L' : 'M'}${points[index].x.toFixed(2)},${points[index].y.toFixed(2)}`).join(' ') + ' Z';

export default function HeroPolygons() {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    const hero = svg?.closest<HTMLElement>('.hero');
    if (!svg || !hero) return;
    const paths = Array.from(svg.querySelectorAll('path'));
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = { x: -1000, y: -1000 };
    let points = vertices.map(point => ({ ...point }));
    let frame = 0;
    let visible = true;
    let active = false;

    const render = () => {
      frame = 0;
      if (!visible || document.hidden) return;
      let moving = false;
      points = points.map((point, index) => {
        const origin = vertices[index];
        const dx = origin.x - pointer.x;
        const dy = origin.y - pointer.y;
        const distance = Math.hypot(dx, dy);
        const influence = active ? Math.max(0, 1 - distance / 190) : 0;
        const shift = media.matches ? 0 : influence * influence * 20;
        const targetX = origin.x + dx / Math.max(distance, 1) * shift;
        const targetY = origin.y + dy / Math.max(distance, 1) * shift;
        const x = media.matches ? targetX : point.x + (targetX - point.x) * 0.14;
        const y = media.matches ? targetY : point.y + (targetY - point.y) * 0.14;
        if (Math.abs(targetX - x) + Math.abs(targetY - y) > 0.08) {
          moving = true;
          return { x, y };
        }
        return { x: targetX, y: targetY };
      });
      facets.forEach((indices, index) => {
        const center = indices.reduce((sum, vertex) => ({ x: sum.x + vertices[vertex].x / 3, y: sum.y + vertices[vertex].y / 3 }), { x: 0, y: 0 });
        const influence = active ? Math.max(0, 1 - Math.hypot(center.x - pointer.x, center.y - pointer.y) / 230) : 0;
        paths[index].setAttribute('d', pathFor(indices, points));
        paths[index].style.fillOpacity = String(0.025 + (index % 5) * 0.012 + influence * 0.34);
        paths[index].style.strokeOpacity = String(0.12 + influence * 0.3);
      });
      if (moving) frame = requestAnimationFrame(render);
    };
    const schedule = () => { if (!frame && visible && !document.hidden) frame = requestAnimationFrame(render); };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const box = svg.getBoundingClientRect();
      pointer.x = (event.clientX - box.left) * width / box.width;
      pointer.y = (event.clientY - box.top) * height / box.height;
      active = true;
      schedule();
    };
    const leave = () => { active = false; schedule(); };
    const visibility = () => {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; active = false; }
      else schedule();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (!visible) { cancelAnimationFrame(frame); frame = 0; active = false; }
      else schedule();
    });
    observer.observe(svg);
    hero.addEventListener('pointermove', move, { passive: true });
    hero.addEventListener('pointerleave', leave);
    media.addEventListener('change', schedule);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      hero.removeEventListener('pointermove', move);
      hero.removeEventListener('pointerleave', leave);
      media.removeEventListener('change', schedule);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  return <svg ref={ref} className="hero-polygons" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
    {facets.map((indices, index) => <path key={index} d={pathFor(indices, vertices)} fillOpacity={0.025 + (index % 5) * 0.012} strokeOpacity={0.12} />)}
  </svg>;
}
