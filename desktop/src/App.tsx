import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  FilePlus2,
  FileStack,
  FolderOpen,
  FolderSearch,
  LoaderCircle,
  TriangleAlert,
  X,
} from 'lucide-react';
import { formatGroups } from './formats';

type PageSize = 'a4' | 'letter' | 'legal' | 'a3' | 'a5';
type Orientation = 'auto' | 'portrait' | 'landscape';
type ImageFit = 'fit' | 'original';

interface Settings {
  pageSize: PageSize;
  orientation: Orientation;
  marginMm: number;
  imageFit: ImageFit;
  outputDir: string | null;
  preferLibreoffice: boolean;
  combine: boolean;
}

interface EngineStatus {
  libreoffice: string | null;
  builtin: string[];
  libreofficeOnly: string[];
}

interface Outcome {
  output: string;
  engine: string;
  pages: number | null;
  bytes: number;
}

type Status = 'waiting' | 'converting' | 'done' | 'failed' | 'pdf';

interface Item {
  id: number;
  path: string;
  name: string;
  ext: string;
  status: Status;
  outcome?: Outcome;
  error?: string;
}

const defaults: Settings = {
  pageSize: 'a4',
  orientation: 'auto',
  marginMm: 15,
  imageFit: 'fit',
  outputDir: null,
  preferLibreoffice: true,
  combine: false,
};

const SETTINGS_KEY = 'folio.desktop.settings';
const native = isTauri();

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;
const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) || path;
const extOf = (path: string) => {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

let nextId = 1;

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [engines, setEngines] = useState<EngineStatus | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [combined, setCombined] = useState<{ path?: string; error?: string } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* Settings persistence is a convenience only. */
    }
  }, [settings]);

  useEffect(() => {
    if (!native) return;
    invoke<EngineStatus>('engine_status').then(setEngines).catch(() => setEngines(null));
  }, []);

  const supported = useMemo(() => {
    const set = new Set<string>(engines?.builtin ?? []);
    if (engines?.libreoffice) engines.libreofficeOnly.forEach(ext => set.add(ext));
    return set;
  }, [engines]);

  const addPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    const files = native ? await invoke<string[]>('expand_paths', { paths }) : paths;
    const known = new Set(itemsRef.current.map(item => item.path));
    const fresh = files
      .filter(path => !known.has(path))
      .map(path => {
        const ext = extOf(path);
        return { id: nextId++, path, name: baseName(path), ext, status: (ext === 'pdf' ? 'pdf' : 'waiting') as Status };
      });
    setCombined(null);
    setItems(current => [...current, ...fresh]);
  }, []);

  useEffect(() => {
    if (!native) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent(event => {
          if (event.payload.type === 'enter' || event.payload.type === 'over') setDragging(true);
          else if (event.payload.type === 'leave') setDragging(false);
          else if (event.payload.type === 'drop') {
            setDragging(false);
            void addPaths(event.payload.paths);
          }
        })
        .then(fn => (cancelled ? fn() : (unlisten = fn))),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addPaths]);

  const pickFiles = async () => {
    if (!native) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: true, directory: false, title: 'Choose files to convert to PDF' });
    if (picked) await addPaths(Array.isArray(picked) ? picked : [picked]);
  };

  const pickOutput = async () => {
    if (!native) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false, title: 'Choose where PDFs are saved' });
    if (typeof picked === 'string') setSettings(s => ({ ...s, outputDir: picked }));
  };

  const update = (id: number, patch: Partial<Item>) =>
    setItems(current => current.map(item => (item.id === id ? { ...item, ...patch } : item)));

  const move = (id: number, delta: number) =>
    setItems(current => {
      const index = current.findIndex(item => item.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const pending = items.filter(item => item.status === 'waiting');
  const combinable = items.filter(item => item.status === 'pdf' || item.status === 'done' || item.status === 'waiting');

  const convertAll = async () => {
    if (!native || busy) return;
    setBusy(true);
    setCombined(null);
    const options = {
      pageSize: settings.pageSize,
      orientation: settings.orientation,
      marginMm: settings.marginMm,
      imageFit: settings.imageFit,
      outputDir: settings.outputDir,
      preferLibreoffice: settings.preferLibreoffice,
    };
    const outputs = new Map<number, string>();
    for (const item of itemsRef.current) {
      if (item.status === 'pdf') outputs.set(item.id, item.path);
      if (item.status === 'done' && item.outcome) outputs.set(item.id, item.outcome.output);
      if (item.status !== 'waiting') continue;
      update(item.id, { status: 'converting', error: undefined });
      try {
        const outcome = await invoke<Outcome>('convert_file', { path: item.path, options });
        outputs.set(item.id, outcome.output);
        update(item.id, { status: 'done', outcome });
      } catch (error) {
        update(item.id, { status: 'failed', error: String(error) });
      }
    }
    if (settings.combine) {
      const ordered = itemsRef.current.map(item => outputs.get(item.id)).filter((p): p is string => !!p);
      if (ordered.length >= 2) {
        const dir = settings.outputDir || folderOf(ordered[0]);
        const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
        try {
          const path = await invoke<string>('merge_pdfs', { paths: ordered, output: `${dir}${sep}Combined.pdf` });
          setCombined({ path });
        } catch (error) {
          setCombined({ error: String(error) });
        }
      } else {
        setCombined({ error: 'Combining needs at least two PDFs.' });
      }
    }
    setBusy(false);
  };

  const openPdf = async (path: string) => {
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(path).catch(() => undefined);
  };
  const reveal = async (path: string) => {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path).catch(() => undefined);
  };

  const done = items.filter(item => item.status === 'done').length;
  const failed = items.filter(item => item.status === 'failed').length;
  const lo = engines?.libreoffice;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(s => ({ ...s, [key]: value }));

  const ticker = [
    'Files never leave this computer',
    `${engines ? engines.builtin.length : '—'} formats built in`,
    lo ? 'LibreOffice found — office formats on' : 'LibreOffice not found — office formats off',
    'Output: PDF, nothing else',
    'Never overwrites an existing file',
  ];

  return (
    <div className={`shell${dragging ? ' is-dragging' : ''}`}>
      <div className="grain" aria-hidden="true" />
      <div className="ticker" aria-hidden="true">
        <div className="ticker__track">
          {[...ticker, ...ticker].map((text, i) => (
            <span key={i}>
              {text}
              <i>✳</i>
            </span>
          ))}
        </div>
      </div>

      <header className="masthead">
        <div className="masthead__inner wrap">
          <div className="brand" aria-label="Folio PDF">
            <span className="brand__mark">
              <span className="brand__box">FOLIO</span>
              <span className="brand__word">PDF</span>
            </span>
            <span className="brand__sub">
              Files to PDF
              <br />
              on this computer
            </span>
          </div>
          <div className="masthead__tools">
            <span className="masthead__check" title={lo || 'Install LibreOffice to convert office formats'}>
              <span className={`live-dot${lo ? '' : ' live-dot--off'}`} />
              LibreOffice <b>{engines ? (lo ? 'found' : 'not found') : native ? 'checking' : 'preview'}</b>
            </span>
            <button className="btn btn--small" type="button" onClick={pickFiles} disabled={!native || busy}>
              Add files <FilePlus2 className="icon" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <main className="wrap" id="main">
        <section className="hero">
          <div className="hero__kicker">
            <span className="file-no">FILE № {String(items.length).padStart(3, '0')}</span>
            <span className="rule" />
            <span>Desktop converter / v0.1</span>
            <span className="hero__kicker-end">
              {done ? (
                <>
                  <b>{done}</b> converted{failed ? ` · ${failed} failed` : ''}
                </>
              ) : (
                'Local only'
              )}
            </span>
          </div>
          <h1 className="hero__title">
            <span className="hero__line">Any file.</span>
            <span className="hero__line hero__line--mark">
              <span className="marker">Straight to PDF.</span>
            </span>
          </h1>
          <p className="hero__lede">
            Drop images, documents, spreadsheets, Markdown or code. Folio typesets them into clean PDFs right here, and saves each one next to
            the original unless you pick a folder.
          </p>
        </section>

        <div className="workspace">
          <section className="desk" aria-label="Files">
            <div className={`drop${dragging ? ' drop--over' : ''}`}>
              <span className="tape tape--a" aria-hidden="true" />
              <span className="crosshair crosshair--a" aria-hidden="true" />
              <span className="crosshair crosshair--b" aria-hidden="true" />
              <div className="drop__top">
                <span>Intake tray</span>
                <span>{items.length ? `${items.length} on file` : 'Empty'}</span>
              </div>
              <p className="drop__title">{dragging ? 'Let go to add them.' : 'Drop files or folders here'}</p>
              <p className="drop__hint">Folders are opened up to four levels deep. PDFs you add are kept as they are and can be combined.</p>
              <div className="drop__actions">
                <button className="btn btn--ink" type="button" onClick={pickFiles} disabled={!native || busy}>
                  Choose files <ArrowRight className="icon" aria-hidden="true" />
                </button>
                {!native && <span className="drop__note">Open this inside the Folio app to convert files.</span>}
              </div>
            </div>

            {items.length > 0 && (
              <div className="queue">
                <div className="section-top">
                  <span className="section-index">
                    <span>01</span> Queue
                  </span>
                  <button className="text-link" type="button" onClick={() => { setItems([]); setCombined(null); }} disabled={busy}>
                    Clear all <X className="icon" aria-hidden="true" />
                  </button>
                </div>
                <ol className="rows">
                  {items.map((item, index) => {
                    const ok = item.ext === 'pdf' || supported.has(item.ext) || !engines;
                    return (
                      <li key={item.id} className={`row row--${item.status}`}>
                        <span className={`stamp-tag${ok ? '' : ' stamp-tag--muted'}`}>{item.ext || 'file'}</span>
                        <div className="row__main">
                          <span className="row__name" title={item.path}>{item.name}</span>
                          <span className="row__meta">
                            {item.status === 'waiting' && (ok ? 'Waiting' : engines?.libreofficeOnly.includes(item.ext) ? 'Needs LibreOffice' : 'Will try as text')}
                            {item.status === 'converting' && 'Converting…'}
                            {item.status === 'pdf' && 'Already a PDF · used when combining'}
                            {item.status === 'done' && item.outcome && (
                              <>
                                {item.outcome.pages ?? '?'} {item.outcome.pages === 1 ? 'page' : 'pages'} · {size(item.outcome.bytes)} · {item.outcome.engine}
                              </>
                            )}
                            {item.status === 'failed' && <span className="row__error">{item.error}</span>}
                          </span>
                        </div>
                        <span className="row__state" aria-label={item.status}>
                          {item.status === 'converting' && <LoaderCircle className="icon spin" />}
                          {item.status === 'done' && <Check className="icon" />}
                          {item.status === 'failed' && <TriangleAlert className="icon" />}
                        </span>
                        <div className="row__actions">
                          {(item.status === 'done' || item.status === 'pdf') && (
                            <>
                              <button className="chip" type="button" onClick={() => openPdf(item.outcome?.output ?? item.path)}>
                                Open <ArrowUpRight className="icon" aria-hidden="true" />
                              </button>
                              <button className="chip" type="button" onClick={() => reveal(item.outcome?.output ?? item.path)} aria-label={`Show ${item.name} in folder`}>
                                <FolderSearch className="icon" aria-hidden="true" />
                              </button>
                            </>
                          )}
                          {item.status === 'failed' && (
                            <button className="chip" type="button" onClick={() => update(item.id, { status: 'waiting', error: undefined })} disabled={busy}>
                              Retry
                            </button>
                          )}
                          <button className="chip" type="button" onClick={() => move(item.id, -1)} disabled={busy || index === 0} aria-label="Move up">
                            <ArrowUp className="icon" aria-hidden="true" />
                          </button>
                          <button className="chip" type="button" onClick={() => move(item.id, 1)} disabled={busy || index === items.length - 1} aria-label="Move down">
                            <ArrowDown className="icon" aria-hidden="true" />
                          </button>
                          <button
                            className="chip"
                            type="button"
                            onClick={() => setItems(current => current.filter(i => i.id !== item.id))}
                            disabled={busy && item.status === 'converting'}
                            aria-label={`Remove ${item.name}`}
                          >
                            <X className="icon" aria-hidden="true" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {combined && (
                  <div className={`combined${combined.error ? ' combined--error' : ''}`}>
                    <FileStack className="icon" aria-hidden="true" />
                    {combined.path ? (
                      <>
                        <span>
                          Combined into <b>{baseName(combined.path)}</b>
                        </span>
                        <button className="chip" type="button" onClick={() => openPdf(combined.path!)}>
                          Open <ArrowUpRight className="icon" aria-hidden="true" />
                        </button>
                        <button className="chip" type="button" onClick={() => reveal(combined.path!)} aria-label="Show combined PDF in folder">
                          <FolderSearch className="icon" aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <span>{combined.error}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <aside className="settings" aria-label="PDF settings">
            <div className="card">
              <div className="card__head">
                <span className="section-index">
                  <span>02</span> Output
                </span>
              </div>

              <label className="field">
                <span className="field__label">Page size</span>
                <select value={settings.pageSize} onChange={e => set('pageSize', e.target.value as PageSize)}>
                  <option value="a4">A4 · 210 × 297 mm</option>
                  <option value="letter">US Letter · 8.5 × 11 in</option>
                  <option value="legal">US Legal · 8.5 × 14 in</option>
                  <option value="a3">A3 · 297 × 420 mm</option>
                  <option value="a5">A5 · 148 × 210 mm</option>
                </select>
              </label>

              <fieldset className="field">
                <legend className="field__label">Orientation</legend>
                <div className="segmented">
                  {(['auto', 'portrait', 'landscape'] as Orientation[]).map(value => (
                    <button key={value} type="button" aria-pressed={settings.orientation === value} onClick={() => set('orientation', value)}>
                      {value}
                    </button>
                  ))}
                </div>
                <span className="field__hint">Auto turns wide images and tables sideways.</span>
              </fieldset>

              <fieldset className="field">
                <legend className="field__label">Margins</legend>
                <div className="segmented">
                  {[
                    ['None', 0],
                    ['Narrow', 8],
                    ['Normal', 15],
                    ['Wide', 25],
                  ].map(([label, mm]) => (
                    <button key={label} type="button" aria-pressed={settings.marginMm === mm} onClick={() => set('marginMm', mm as number)}>
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="field">
                <legend className="field__label">Images</legend>
                <div className="segmented">
                  <button type="button" aria-pressed={settings.imageFit === 'fit'} onClick={() => set('imageFit', 'fit')}>
                    Fit to page
                  </button>
                  <button type="button" aria-pressed={settings.imageFit === 'original'} onClick={() => set('imageFit', 'original')}>
                    Original size
                  </button>
                </div>
              </fieldset>

              <div className="field">
                <span className="field__label">Save to</span>
                <div className="save-to">
                  <span className="save-to__path" title={settings.outputDir || undefined}>
                    {settings.outputDir ? baseName(settings.outputDir) : 'Next to each original'}
                  </span>
                  <button className="chip" type="button" onClick={pickOutput} disabled={!native}>
                    <FolderOpen className="icon" aria-hidden="true" /> Choose
                  </button>
                  {settings.outputDir && (
                    <button className="chip" type="button" onClick={() => set('outputDir', null)} aria-label="Save next to each original">
                      <X className="icon" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>

              <label className="toggle">
                <input type="checkbox" checked={settings.combine} onChange={e => set('combine', e.target.checked)} />
                <span className="toggle__box" aria-hidden="true" />
                <span>
                  Also combine into one PDF
                  <small>In queue order, saved as Combined.pdf.</small>
                </span>
              </label>

              <label className={`toggle${lo ? '' : ' toggle--off'}`}>
                <input type="checkbox" checked={settings.preferLibreoffice && !!lo} disabled={!lo} onChange={e => set('preferLibreoffice', e.target.checked)} />
                <span className="toggle__box" aria-hidden="true" />
                <span>
                  Use LibreOffice for Word, Excel and HTML
                  <small>{lo ? 'Keeps the original layout, images and fonts.' : 'Not installed. Get it free from libreoffice.org, then restart Folio.'}</small>
                </span>
              </label>

              <button className="btn btn--ink btn--wide" type="button" onClick={convertAll} disabled={!native || busy || (!pending.length && !(settings.combine && combinable.length >= 2))}>
                {busy ? (
                  <>
                    Converting <LoaderCircle className="icon spin" aria-hidden="true" />
                  </>
                ) : (
                  <>
                    {pending.length ? `Convert ${pending.length} ${pending.length === 1 ? 'file' : 'files'}` : settings.combine ? 'Combine PDFs' : 'Nothing to convert'}
                    <ArrowRight className="icon" aria-hidden="true" />
                  </>
                )}
              </button>
            </div>
          </aside>
        </div>

        <section className="formats" aria-labelledby="formats-title">
          <div className="section-top">
            <span className="section-index">
              <span>03</span> Formats
            </span>
            <span className="section-index">{lo ? 'All engines ready' : 'Built-in engines ready'}</span>
          </div>
          <h2 className="section-title" id="formats-title">
            What Folio <span className="marker">reads.</span>
          </h2>
          <div className="formats__grid">
            {formatGroups.map(group => {
              const off = group.office && engines && !lo;
              return (
                <article key={group.label} className={`format${off ? ' format--off' : ''}`}>
                  <h3>{group.label}</h3>
                  <p>{off ? 'Install LibreOffice to turn these on.' : group.note}</p>
                  <div className="format__tags">
                    {group.exts.map(ext => (
                      <span key={ext} className="tag">
                        .{ext}
                      </span>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="footer wrap">
        <span>Folio desktop · converted on this computer · nothing is uploaded</span>
        <span>Images, text, Markdown, CSV, spreadsheets and Word are built in. LibreOffice adds full-fidelity office formats.</span>
      </footer>
    </div>
  );
}
