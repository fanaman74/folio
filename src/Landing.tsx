import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { ArrowRight, BookOpen, Check, Database, FileText, Film, FolderOpen, Image, Layers2, LockKeyhole, Music2, ShieldCheck, SlidersHorizontal, Table2, Upload, ArrowDownToLine } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const families: { icon: LucideIcon; title: string; text: string; formats: string }[] = [
  { icon: Image, title: 'Images', text: 'Resize nothing, lose nothing. Switch photos and graphics in one pass.', formats: 'JPG · PNG · WebP · AVIF · TIFF · GIF' },
  { icon: FileText, title: 'Documents', text: 'Turn drafts into shareable PDFs or editable files again.', formats: 'DOCX · ODT · RTF · TXT · PDF' },
  { icon: Table2, title: 'Spreadsheets', text: 'Export sheets for anyone, whatever they open them with.', formats: 'XLSX · ODS · CSV · PDF' },
  { icon: Layers2, title: 'Presentations', text: 'Send the deck as a PDF, or move it between suites.', formats: 'PPTX · ODP · PDF' },
  { icon: Film, title: 'Video', text: 'Re-wrap clips, make a GIF, or pull the soundtrack out.', formats: 'MP4 · WebM · MKV · MOV' },
  { icon: Music2, title: 'Audio', text: 'From studio-grade to pocket-sized and back again.', formats: 'MP3 · WAV · FLAC · OGG · M4A' },
  { icon: Database, title: 'Data', text: 'Reshape structured data without writing a script.', formats: 'CSV · TSV · JSON · YAML · XML' },
  { icon: BookOpen, title: 'E-books & markup', text: 'Move writing between Markdown, HTML, EPUB and Word.', formats: 'EPUB · MD · HTML · DOCX' },
  { icon: FileText, title: 'PDF text', text: 'Pull the words back out of a PDF as plain text.', formats: 'PDF → TXT' },
];
const marquee = ['JPG', 'PNG', 'WEBP', 'AVIF', 'PDF', 'DOCX', 'XLSX', 'PPTX', 'CSV', 'JSON', 'YAML', 'MP4', 'WEBM', 'MP3', 'FLAC', 'EPUB', 'MARKDOWN', 'HTML'];
const demo = [
  { name: 'quarterly-report.docx', from: 'DOCX', to: 'PDF', icon: FileText },
  { name: 'team-photo.png', from: 'PNG', to: 'WEBP', icon: Image },
  { name: 'customers.csv', from: 'CSV', to: 'JSON', icon: Table2 },
  { name: 'interview.wav', from: 'WAV', to: 'MP3', icon: Music2 },
];

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!('IntersectionObserver' in window)) { setShown(true); return; }
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setShown(true); observer.disconnect(); } }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, shown] as const;
}

function Reveal({ children, className = '', delay = 0, as: Tag = 'div' }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'section' | 'li' }) {
  const [ref, shown] = useReveal<HTMLDivElement>();
  return <Tag ref={ref as never} className={`reveal ${shown ? 'in' : ''} ${className}`} style={{ '--delay': `${delay}ms` } as CSSProperties}>{children}</Tag>;
}

function Words({ text, start = 0, accent }: { text: string; start?: number; accent?: string }) {
  return <>{text.split(' ').map((word, index) => <span key={index} className={`word ${word === accent ? 'accent' : ''}`} style={{ '--delay': `${start + index * 90}ms` } as CSSProperties}>{word}{' '}</span>)}</>;
}

function CountUp({ to, suffix = '' }: { to: number; suffix?: string }) {
  const [ref, shown] = useReveal<HTMLSpanElement>();
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!shown) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setValue(to); return; }
    let frame = 0;
    const begin = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - begin) / 1300);
      setValue(Math.round(to * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [shown, to]);
  return <span ref={ref} className="count">{value}{suffix}</span>;
}

function Preview() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setStep(demo.length * 2); return; }
    const timer = setInterval(() => setStep(current => current >= demo.length * 2 + 3 ? 0 : current + 1), 850);
    return () => clearInterval(timer);
  }, []);
  const done = demo.filter((_, index) => step > index * 2 + 1).length;
  return <div className="preview" aria-hidden="true">
    <div className="preview-bar"><span /><span /><span /><p>folio — converter</p></div>
    <div className="preview-body">
      <div className="preview-files">
        <div className="preview-heading"><strong>Your files</strong><em>{demo.length}</em><span className={done === demo.length ? 'ready' : ''}>{done === demo.length ? <><Check size={12} /> Ready</> : <>Converting {done} of {demo.length}</>}</span></div>
        <ul>{demo.map((item, index) => {
          const state = step > index * 2 + 1 ? 'done' : step > index * 2 ? 'active' : 'waiting';
          const Icon = item.icon;
          return <li key={item.name} className={state} style={{ '--delay': `${900 + index * 120}ms` } as CSSProperties}>
            <span className="preview-icon"><Icon size={17} /></span>
            <span className="preview-name">{state === 'done' ? item.name.replace(/\.[^.]+$/, `.${item.to.toLowerCase()}`) : item.name}</span>
            <span className="preview-chip"><b>{item.from}</b><ArrowRight size={11} /><b>{item.to}</b></span>
            <span className="preview-state">{state === 'done' ? <Check size={14} /> : state === 'active' ? <i className="preview-spinner" /> : null}</span>
            <span className="preview-progress" />
          </li>;
        })}</ul>
      </div>
      <div className="preview-side">
        <p><SlidersHorizontal size={13} /> Conversion settings</p>
        <div className="preview-field"><small>Convert to</small><span>Best match per file</span></div>
        <div className="preview-field"><small>Quality</small><span className="preview-slider"><i /></span></div>
        <div className={`preview-download ${done === demo.length ? 'on' : ''}`}><ArrowDownToLine size={14} /> Download ZIP</div>
      </div>
    </div>
  </div>;
}

function Spotlight({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const move = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--x', `${event.clientX - box.left}px`);
    event.currentTarget.style.setProperty('--y', `${event.clientY - box.top}px`);
  };
  return <Reveal delay={delay} className={className}><div className="spotlight" onMouseMove={move}>{children}</div></Reveal>;
}

export default function Landing() {
  const tilt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.title = 'Folio — Your files. A fresh format.';
    const element = tilt.current;
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const progress = Math.min(1, window.scrollY / 420);
      element.style.setProperty('--tilt', `${16 * (1 - progress)}deg`);
      element.style.setProperty('--lift', `${1 - 0.06 * (1 - progress)}`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    return () => { window.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); };
  }, []);

  return <div className="landing">
    <div className="landing-glow" aria-hidden="true" />
    <header className="landing-header">
      <a className="brand" href="/" aria-label="Folio home"><span className="brand-mark"><FileText size={22} /><ArrowRight size={13} /></span>folio<span className="brand-period">.</span></a>
      <nav aria-label="Intro navigation"><a href="#formats">Formats</a><a href="#how">How it works</a><a href="#privacy">Privacy</a></nav>
      <a className="button primary header-cta" href="/convert">Open converter <ArrowRight size={15} /></a>
    </header>

    <main>
      <section className="hero">
        <p className="eyebrow intro-fade"><span className="pulse" /> Private by design · no account needed</p>
        <h1 aria-label="Your files. A fresh format."><span className="line"><Words text="Your files." /></span><span className="line"><Words text="A fresh format." start={260} accent="fresh" /></span></h1>
        <p className="hero-copy intro-fade" style={{ '--delay': '700ms' } as CSSProperties}>Drop in one file or a whole folder, pick what it should become, and download the result. Folio converts on its own server and clears everything when you are done.</p>
        <div className="hero-actions intro-fade" style={{ '--delay': '850ms' } as CSSProperties}>
          <a className="button primary big" href="/convert"><Upload size={17} /> Start converting <ArrowRight size={16} /></a>
          <a className="button ghost big" href="#formats">See what it converts</a>
        </div>
        <div className="stage" ref={tilt}><div className="stage-inner intro-rise"><Preview /></div></div>
      </section>

      <div className="marquee" aria-label="Supported formats include JPG, PNG, PDF, DOCX, CSV, MP4, MP3 and more">
        <div className="marquee-track" aria-hidden="true">{[...marquee, ...marquee].map((item, index) => <span key={index}>{item}</span>)}</div>
      </div>

      <section className="landing-section" id="formats">
        <Reveal className="section-heading"><p className="kicker">What it converts</p><h2>Nine file families. <em>One</em> workspace.</h2><p>Folio only offers conversions its engines can really do, so every option you see is one that works.</p></Reveal>
        <div className="family-grid">{families.map(({ icon: Icon, title, text, formats }, index) => <Spotlight key={title} delay={(index % 3) * 90 + Math.floor(index / 3) * 60}>
          <span className="family-icon"><Icon size={20} /></span><h3>{title}</h3><p>{text}</p><small>{formats}</small>
        </Spotlight>)}</div>
      </section>

      <section className="landing-section stats-section">
        <Reveal className="section-heading"><p className="kicker">By the numbers</p><h2>Light by <em>design</em>.</h2></Reveal>
        <div className="stats">
          <Reveal delay={0}><CountUp to={100} /><p>files in a single batch</p></Reveal>
          <Reveal delay={120}><CountUp to={500} suffix=" MB" /><p>per batch, 100 MB per file</p></Reveal>
          <Reveal delay={240}><CountUp to={0} /><p>accounts, databases or file history</p></Reveal>
        </div>
      </section>

      <section className="landing-section" id="how">
        <Reveal className="section-heading"><p className="kicker">How it works</p><h2>Three steps. <em>No</em> detours.</h2></Reveal>
        <ol className="steps">
          {[{ icon: FolderOpen, title: 'Bring your files', text: 'Choose files or a whole folder, or drag them straight in. Folder structure is kept.' },
            { icon: SlidersHorizontal, title: 'Pick a new format', text: 'Set one format for the batch or a different one per file. Only compatible choices appear.' },
            { icon: ArrowDownToLine, title: 'Download and go', text: 'Grab files one by one or as a ZIP. Each download clears its copy from the server.' }].map(({ icon: Icon, title, text }, index) => <Reveal as="li" key={title} delay={index * 160} className="step">
            <span className="step-number">0{index + 1}</span><span className="step-icon"><Icon size={20} /></span><h3>{title}</h3><p>{text}</p>
          </Reveal>)}
        </ol>
      </section>

      <section className="landing-section" id="privacy">
        <Reveal className="privacy-band">
          <span className="privacy-icon"><LockKeyhole size={24} /></span>
          <div><p className="kicker">Private by design</p><h2>Your files are only here to be converted.</h2><p>Processing happens on Folio's own server, with no third-party converters. Originals are deleted after conversion, results are deleted after download, and anything left behind expires automatically.</p></div>
          <ul><li><ShieldCheck size={16} /> No sign-up</li><li><ShieldCheck size={16} /> No file history</li><li><ShieldCheck size={16} /> Auto-expiry</li></ul>
        </Reveal>
      </section>

      <section className="landing-section">
        <Reveal className="final-cta">
          <h2>Ready for a <em>fresh</em> format?</h2>
          <p>No account, no install. Just your files.</p>
          <a className="button light big" href="/convert">Open the converter <ArrowRight size={16} /></a>
        </Reveal>
      </section>
    </main>
    <footer className="landing-footer"><span className="footer-brand">folio.</span><span>A small tool for your next big thing.</span><a href="/convert">Converter</a></footer>
  </div>;
}
