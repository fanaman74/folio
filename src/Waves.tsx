import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Moon, Sun } from 'lucide-react';

// Layered hills that drift slowly behind the page. Each layer gets a little brighter towards the bottom.
const layers = [
  { d: 'M760,0 C900,40 1120,90 1220,260 C1300,400 1380,380 1440,360 L1440,0 Z', from: 0.55, to: 0.8, x: '-1.6%', y: '1.2%', r: '-1.2deg', dur: 26, delay: -4 },
  { d: 'M0,300 C180,160 420,90 640,170 C860,250 1000,420 1440,350 L1440,900 L0,900 Z', from: 0.15, to: 0.6, x: '1.4%', y: '-1%', r: '.8deg', dur: 30, delay: -11 },
  { d: 'M0,760 C200,580 420,520 700,580 C980,640 1180,470 1440,440 L1440,900 L0,900 Z', from: 0.45, to: 0.85, x: '-1.2%', y: '1.4%', r: '-.7deg', dur: 24, delay: -7 },
  { d: 'M180,900 C300,740 480,680 760,720 C1040,760 1240,700 1440,690 L1440,900 Z', from: 0.7, to: 1, x: '1.8%', y: '-.8%', r: '.6deg', dur: 22, delay: -2 },
];

export function Waves({ quiet = false }: { quiet?: boolean }) {
  return <div className={`waves ${quiet ? 'quiet' : ''}`} aria-hidden="true">
    <div className="waves-dots" />
    {layers.map((layer, index) => <div key={index} className="wave" style={{ '--wave-x': layer.x, '--wave-y': layer.y, '--wave-r': layer.r, '--wave-dur': `${layer.dur}s`, '--wave-delay': `${layer.delay}s` } as CSSProperties}>
      <svg viewBox="0 0 1440 900" preserveAspectRatio="none">
        <defs><linearGradient id={`wave-${index}`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" style={{ stopColor: `color-mix(in oklab, var(--wave-a), var(--wave-b) ${layer.from * 100}%)` }} />
          <stop offset="1" style={{ stopColor: `color-mix(in oklab, var(--wave-a), var(--wave-b) ${layer.to * 100}%)` }} />
        </linearGradient></defs>
        <path d={layer.d} fill={`url(#wave-${index})`} />
      </svg>
    </div>)}
  </div>;
}

const readTheme = () => document.documentElement.classList.contains('light') ? 'light' : 'dark';

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f3f7f5' : '#0b0e13');
    try { localStorage.setItem('folio-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const next = theme === 'light' ? 'dark' : 'light';
  return <button type="button" className="theme-toggle" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>{theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}</button>;
}
