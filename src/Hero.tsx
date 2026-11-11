import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowDown, ArrowRight, Check, FileText, Film, Image, Layers2, Music2, ShieldCheck, Table2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import HeroPolygons from './HeroPolygons';

export type Mode = 'pdf' | 'all';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Words({ text, start = 0, accent }: { text: string; start?: number; accent?: string }) {
  return <>{text.split(' ').map((word, index) => <span key={index} className={`word ${word === accent ? 'accent' : ''}`} style={{ '--delay': `${start + index * 90}ms` } as CSSProperties}>{word}{' '}</span>)}</>;
}

const sources: { label: string; name: string; icon: LucideIcon }[] = [
  { label: 'DOCX', name: 'proposal.docx', icon: FileText },
  { label: 'XLSX', name: 'budget.xlsx', icon: Table2 },
  { label: 'PPTX', name: 'pitch.pptx', icon: Layers2 },
];

// Each source document slides into the PDF in turn; the sheet fills one page per document, then the loop restarts.
function PdfStage() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reduced()) { setStep(sources.length); return; }
    const timer = setInterval(() => setStep(current => (current + 1) % (sources.length + 2)), 1400);
    return () => clearInterval(timer);
  }, []);
  const merged = Math.min(step, sources.length);
  return <div className="stage pdf-stage" aria-hidden="true">
    <div className="stage-sources">{sources.map(({ label, name, icon: Icon }, index) => <div key={label} className={`source-card ${index < merged ? 'sent' : index === merged ? 'next' : ''}`} style={{ '--i': index } as CSSProperties}>
      <span className="source-icon"><Icon size={18} /></span><span className="source-name">{name}</span><b>{label}</b>
    </div>)}</div>
    <div className="stage-beam"><span /><ArrowRight size={16} /></div>
    <div className={`pdf-sheet ${merged === sources.length ? 'complete' : ''}`}>
      <div className="pdf-sheet-head"><span className="pdf-badge">PDF</span><span>combined.pdf</span></div>
      <div className="pdf-lines">{Array.from({ length: 9 }, (_, index) => <i key={index} className={index < merged * 3 ? 'on' : ''} style={{ '--w': `${[92, 78, 85, 64, 88, 72, 95, 58, 80][index]}%` } as CSSProperties} />)}</div>
      <div className="pdf-sheet-foot"><span>{merged} of {sources.length} pages</span>{merged === sources.length && <span className="pdf-ready"><Check size={13} /> Ready</span>}</div>
    </div>
  </div>;
}

const pairs = [['PNG', 'WEBP'], ['WAV', 'MP3'], ['CSV', 'JSON'], ['MP4', 'GIF'], ['EPUB', 'DOCX'], ['FLAC', 'M4A']];
const outer: { label: string; icon: LucideIcon }[] = [{ label: 'JPG', icon: Image }, { label: 'MP4', icon: Film }, { label: 'MP3', icon: Music2 }, { label: 'CSV', icon: Table2 }, { label: 'AVIF', icon: Image }, { label: 'WEBM', icon: Film }];
const inner = ['YAML', 'FLAC', 'GIF', 'XML', 'EPUB'];

// Format chips orbit a central converter that cycles through real conversion pairs.
function OrbitStage() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduced()) return;
    const timer = setInterval(() => setIndex(current => (current + 1) % pairs.length), 1800);
    return () => clearInterval(timer);
  }, []);
  const [from, to] = pairs[index];
  return <div className="stage orbit-stage" aria-hidden="true">
    <div className="orbit outer">{outer.map(({ label, icon: Icon }, position) => <span key={label} className="orbit-chip" style={{ '--a': `${position * 360 / outer.length}deg` } as CSSProperties}><span><Icon size={13} />{label}</span></span>)}</div>
    <div className="orbit inner">{inner.map((label, position) => <span key={label} className="orbit-chip small" style={{ '--a': `${position * 360 / inner.length + 20}deg` } as CSSProperties}><span>{label}</span></span>)}</div>
    <div className="orbit-core"><div key={index} className="orbit-pair"><b>{from}</b><ArrowRight size={15} /><b>{to}</b></div><small>Folio engine</small></div>
  </div>;
}

export default function Hero({ mode }: { mode: Mode }) {
  const pdf = mode === 'pdf';
  return <section className={`hero hero-${mode}`}>
    <HeroPolygons />
    <div className="hero-text">
      <p className="eyebrow intro-fade"><span className="pulse" /> {pdf ? 'Word, Excel and PowerPoint to PDF' : 'Images, audio, video, data and e-books'}</p>
      {pdf
        ? <h1 aria-label="Any document. One clean PDF."><span className="line"><Words text="Any document." /></span><span className="line"><Words text="One clean PDF." start={260} accent="clean" /></span></h1>
        : <h1 aria-label="Everything else. A fresh format."><span className="line"><Words text="Everything else." /></span><span className="line"><Words text="A fresh format." start={260} accent="fresh" /></span></h1>}
      <p className="hero-copy intro-fade" style={{ '--delay': '700ms' } as CSSProperties}>{pdf
        ? 'Drop in documents, spreadsheets or slides, or a whole folder of them. Folio renders each one as a PDF on its own server and clears everything once you download.'
        : 'Photos, recordings, clips, data files and e-books. Pick what each file should become and Folio only offers conversions it can really do.'}</p>
      <div className="hero-actions intro-fade" style={{ '--delay': '850ms' } as CSSProperties}>
        <a className="button primary big" href="#converter">{pdf ? 'Convert to PDF' : 'Start converting'} <ArrowDown size={16} /></a>
        <span className="hero-note"><ShieldCheck size={15} /> No account. Files deleted after download.</span>
      </div>
    </div>
    <div className="hero-visual intro-rise">{pdf ? <PdfStage /> : <OrbitStage />}</div>
  </section>;
}
