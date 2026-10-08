import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, File, FileImage, FileText, Film, Folder, FolderOpen, Image, Layers2, LoaderCircle, LockKeyhole, Music2, Plus, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Table2, Upload, X, CircleAlert, BookOpen, CheckCircle2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Output = { format: string; engine: string };
type Capabilities = { formats: Record<string, { category: string; outputs: Output[] }>; categories: { id: string; label: string; inputs: string[]; outputs: string[]; available: boolean }[]; engines: Record<string, boolean>; limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; retentionMs: number } };
type Selection = { id: string; file: File; path: string; target: string };
type JobFile = { id: string; name: string; path: string; from: string; target: string; status: string; error?: string; outputSize?: number; outputName: string };
type Job = { id: string; status: string; expiresAt: number; files: JobFile[] };
type Entry = { isFile: boolean; isDirectory: boolean; name: string; file: (callback: (file: File) => void, error: (error: DOMException) => void) => void; createReader: () => { readEntries: (callback: (entries: Entry[]) => void, error: (error: DOMException) => void) => void } };
const categoryIcons: Record<string, LucideIcon> = { images: Image, documents: FileText, spreadsheets: Table2, presentations: Layers2, audio: Music2, video: Film, data: Table2, ebooks: BookOpen, pdf: FileText };
const formatNames: Record<string, string> = { jpg: 'JPEG image', png: 'PNG image', webp: 'WebP image', avif: 'AVIF image', tiff: 'TIFF image', gif: 'GIF image', pdf: 'PDF document', docx: 'Word document', txt: 'Plain text', html: 'HTML document', csv: 'CSV spreadsheet', json: 'JSON data', yaml: 'YAML data', xml: 'XML data', mp4: 'MP4 video', mp3: 'MP3 audio', epub: 'EPUB e-book' };
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ext = (name: string) => name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
const activeStatuses = ['queued', 'converting'];
async function responseJson(response: Response) { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.'); return data; }
async function walk(entry: Entry, prefix = ''): Promise<{ file: File; path: string }[]> {
  if (entry.isFile) return new Promise((resolve, reject) => entry.file(file => resolve([{ file, path: prefix + entry.name }]), reject));
  const reader = entry.createReader();
  const results: { file: File; path: string }[] = [];
  while (true) {
    const entries = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!entries.length) break;
    for (const child of entries) {
      results.push(...await walk(child, `${prefix}${entry.name}/`));
      if (results.length > 100) throw new Error('Select a folder with no more than 100 files.');
    }
  }
  return results;
}

export default function App() {
  const [cap, setCap] = useState<Capabilities | null>(null);
  const [files, setFiles] = useState<Selection[]>([]);
  const [mode, setMode] = useState<'files' | 'folder'>('files');
  const [view, setView] = useState<'convert' | 'formats'>('convert');
  const [format, setFormat] = useState('');
  const [quality, setQuality] = useState(85);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const currentJob = useRef<string | null>(null);
  const currentFiles = useRef<Selection[]>([]);
  const dragDepth = useRef(0);
  const helpRef = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const busy = uploading || reading || !!(job && activeStatuses.includes(job.status));
  const terminal = !!job && !activeStatuses.includes(job.status);
  const total = files.reduce((sum, item) => sum + item.file.size, 0);
  const available = [...new Set(Object.values(cap?.formats || {}).flatMap(item => item.outputs.map(output => output.format)))].sort();
  const batchFormats = files.length ? available.filter(target => files.some(item => cap?.formats[ext(item.path)]?.outputs.some(output => output.format === target))) : available;
  const invalid = files.filter(item => !cap?.formats[ext(item.path)]?.outputs.some(output => output.format === item.target));
  const successes = job?.files.filter(file => file.status === 'done') || [];
  const settled = job?.files.filter(file => ['done', 'error', 'downloaded'].includes(file.status)).length || 0;

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    fetch('/api/capabilities', { signal: controller.signal }).then(responseJson).then(setCap).catch(error => { if (error.name !== 'AbortError') setError('Could not connect to the converter. Refresh the page to try again.'); });
    const discard = () => { if (currentJob.current) void fetch(`/api/jobs/${currentJob.current}`, { method: 'DELETE', keepalive: true }); };
    window.addEventListener('pagehide', discard);
    return () => { mounted.current = false; controller.abort(); window.removeEventListener('pagehide', discard); };
  }, []);
  useEffect(() => { currentJob.current = job?.id || null; }, [job]);
  useEffect(() => { currentFiles.current = files; }, [files]);
  useEffect(() => {
    if (!job || !activeStatuses.includes(job.status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`, { signal: controller.signal });
        const next = await responseJson(response);
        if (!controller.signal.aborted) setJob(next);
        if (activeStatuses.includes(next.status)) timer = setTimeout(poll, 1000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : 'Could not check conversion status.');
        timer = setTimeout(poll, 3000);
      }
    };
    timer = setTimeout(poll, 700);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!job || !terminal) return;
    const timer = setTimeout(() => { setError('These results have expired and were deleted. Start a new conversion to try again.'); setJob(null); }, Math.max(0, job.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [job, terminal]);

  function addFiles(incoming: { file: File; path: string }[]) {
    if (!cap || busy || job || downloaded) return;
    setError(''); setNotice('');
    const next = [...files];
    let duplicate = 0;
    for (const item of incoming) {
      if (next.some(existing => existing.path === item.path && existing.file.size === item.file.size && existing.file.lastModified === item.file.lastModified)) { duplicate++; continue; }
      if (next.length >= cap.limits.maxFiles) { setError(`You can convert up to ${cap.limits.maxFiles} files at a time.`); break; }
      if (item.file.size > cap.limits.maxFileBytes || next.reduce((sum, file) => sum + file.file.size, 0) + item.file.size > cap.limits.maxTotalBytes) { setError('Some files exceed the limits: 100 MB per file and 500 MB per batch.'); continue; }
      const outputs = cap.formats[ext(item.path)]?.outputs || [];
      const preferred = outputs.find(output => output.format === format) || outputs.find(output => output.format === 'pdf') || outputs.find(output => output.format === 'png') || outputs.find(output => output.format === 'json') || outputs[0];
      next.push({ ...item, id: crypto.randomUUID(), target: preferred?.format || '' });
    }
    setFiles(next);
    if (!incoming.length) setNotice('This folder is empty. Choose a folder containing files.');
    else if (duplicate) setNotice(`${duplicate} duplicate ${duplicate === 1 ? 'file was' : 'files were'} skipped.`);
  }
  async function drop(event: DragEvent) {
    event.preventDefault(); setDragging(false); dragDepth.current = 0;
    if (busy || job || downloaded || !cap) return;
    // Capture entries while the browser's drop data store is still readable.
    const entries = [...event.dataTransfer.items].map(item => item.webkitGetAsEntry() as Entry | null).filter((item): item is Entry => !!item);
    const fallback = [...event.dataTransfer.files];
    setReading(true);
    try {
      const incoming = entries.length ? (await Promise.all(entries.map(entry => walk(entry)))).flat() : fallback.map(file => ({ file, path: file.name }));
      // addFiles guards reading, so release it before committing this selection.
      setReading(false);
      const next = [...files];
      const supportedIncoming = incoming.filter(item => !next.some(existing => existing.path === item.path && existing.file.size === item.file.size && existing.file.lastModified === item.file.lastModified));
      if (next.length + supportedIncoming.length > cap.limits.maxFiles) throw new Error('Select no more than 100 files at a time.');
      if (supportedIncoming.some(item => item.file.size > cap.limits.maxFileBytes) || total + supportedIncoming.reduce((sum, item) => sum + item.file.size, 0) > cap.limits.maxTotalBytes) throw new Error('The selection exceeds the size limits. Choose smaller or fewer files.');
      setFiles([...next, ...supportedIncoming.map(item => {
        const outputs = cap.formats[ext(item.path)]?.outputs || [];
        const target = outputs.find(output => output.format === format)?.format || outputs.find(output => output.format === 'pdf')?.format || outputs.find(output => output.format === 'png')?.format || outputs[0]?.format || '';
        return { ...item, id: crypto.randomUUID(), target };
      })]);
      setNotice(incoming.length ? '' : 'This folder is empty. Choose a folder containing files.'); setError('');
    } catch (error) { setError(error instanceof Error ? error.message : 'This folder could not be read. Use Choose folder to try again.'); }
    finally { setReading(false); }
  }
  function applyFormat(value: string) {
    setFormat(value);
    setFiles(files.map(item => cap?.formats[ext(item.path)]?.outputs.some(output => output.format === value) ? { ...item, target: value } : item));
  }
  async function convertFiles() {
    if (!files.length || invalid.length || busy) return;
    setError(''); setNotice(''); setUploading(true); setUploadProgress(0);
    const body = new FormData();
    body.append('manifest', JSON.stringify(files.map(item => ({ path: item.path, target: item.target }))));
    body.append('quality', String(quality));
    for (const item of files) body.append('files', item.file, item.file.name);
    const request = new XMLHttpRequest();
    xhr.current = request;
    request.open('POST', '/api/jobs');
    request.timeout = 180_000;
    request.upload.onprogress = event => { if (event.lengthComputable) setUploadProgress(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => {
      setUploading(false); setUploadProgress(null); xhr.current = null;
      try {
        const data = JSON.parse(request.responseText);
        if (request.status >= 400) throw new Error(data.error);
        // Store synchronously so pagehide can discard an accepted job immediately.
        currentJob.current = data.id;
        if (mounted.current) setJob(data);
      } catch (error) { setError(error instanceof Error ? error.message : 'The upload failed. Try again.'); }
    };
    request.onerror = request.ontimeout = () => { setUploading(false); setUploadProgress(null); xhr.current = null; setError('The upload could not finish. Check your connection and try again.'); };
    request.onabort = () => { setUploading(false); setUploadProgress(null); xhr.current = null; };
    request.send(body);
  }
  async function reset() {
    xhr.current?.abort();
    const id = currentJob.current;
    if (id) {
      try { await fetch(`/api/jobs/${id}`, { method: 'DELETE' }); }
      catch { setError('Could not confirm deletion. Temporary files will still expire automatically.'); return; }
    }
    currentJob.current = null;
    setJob(null); setFiles([]); setError(''); setNotice(''); setDownloaded(false); setFormat('');
    if (fileInput.current) fileInput.current.value = '';
    if (folderInput.current) folderInput.current.value = '';
  }
  async function download(file?: JobFile) {
    if (!job || downloading) return;
    setDownloading(true); setError('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/${file ? `files/${file.id}` : 'download'}`);
      if (!response.ok) await responseJson(response);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file ? file.outputName.split('/').at(-1)! : 'folio-converted.zip';
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
      if (!file || successes.length === 1) { currentJob.current = null; setDownloaded(true); setJob(null); }
      else setJob({ ...job, files: job.files.map(item => item.id === file.id ? { ...item, status: 'downloaded' } : item) });
    } catch (error) { setError(error instanceof Error ? error.message : 'The download could not finish. Try again.'); }
    finally { setDownloading(false); }
  }
  const selectFiles = (folder = mode === 'folder') => (folder ? folderInput : fileInput).current?.click();
  const renderFormats = () => <section className="format-library" aria-labelledby="formats-heading"><div className="library-heading"><div><h2 id="formats-heading">Find your format.</h2><p>Available conversions on this server, updated automatically.</p></div><button className="text-button" onClick={() => setView('convert')}><ArrowLeft size={16} /> Back to converter</button></div><label className="search"><Search size={18} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search formats, e.g. JPG or DOCX" aria-label="Search supported formats" /></label>{cap?.categories.filter(category => !search || [...category.inputs, ...category.outputs, category.label].some(value => value.toLowerCase().includes(search.toLowerCase()))).map(category => { const Icon = categoryIcons[category.id] || File; return <div className="format-group" key={category.id}><div className="format-group-title"><Icon size={21} /><h3>{category.label}</h3>{!category.available && <span className="engine-pending">Engine not installed</span>}</div><div className="format-pairs">{category.inputs.filter(input => cap.formats[input] && (!search || input.includes(search.toLowerCase()) || category.label.toLowerCase().includes(search.toLowerCase()) || cap.formats[input].outputs.some(output => output.format.includes(search.toLowerCase())))).map(input => <div className="format-pair" key={input}><strong>{input.toUpperCase()}</strong><ArrowRight size={14} /><span>{cap.formats[input].outputs.map(output => output.format.toUpperCase()).join(', ')}</span></div>)}{!category.available && <p className="muted">This server needs the {['audio', 'video'].includes(category.id) ? 'media' : category.id === 'ebooks' ? 'e-book' : 'office'} conversion engine. These formats will become available once it is installed.</p>}</div></div>; })}{search && cap && !Object.entries(cap.formats).some(([input, value]) => input.includes(search.toLowerCase()) || value.outputs.some(output => output.format.includes(search.toLowerCase())) || cap.categories.find(category => category.id === value.category)?.label.toLowerCase().includes(search.toLowerCase())) && <p className="no-results">No available conversions match “{search}”. Try another format.</p>}</section>;

  return <div className="app"><header className="site-header"><a className="brand" href="/" aria-label="Folio home"><span className="brand-mark"><FileText size={22} /><ArrowRight size={13} /></span>folio<span className="brand-period">.</span></a><nav aria-label="Main navigation"><button className={view === 'convert' ? 'nav-link active' : 'nav-link'} aria-current={view === 'convert' ? 'page' : undefined} onClick={() => setView('convert')}>Converter</button><button className={view === 'formats' ? 'nav-link active' : 'nav-link'} aria-current={view === 'formats' ? 'page' : undefined} onClick={() => setView('formats')}>Supported formats</button></nav><button className="help-link" onClick={() => { setHelpOpen(true); setTimeout(() => helpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 20); }}><CircleHelp size={17} /> <span>How it works</span></button></header>
    <main><div className="page-intro"><div><h1>Your files.<br className="mobile-break" /> A fresh format.</h1><p>One file or a whole folder. Make the switch in a few clicks.</p></div><button className="privacy-tag" onClick={() => setPrivacyOpen(!privacyOpen)} aria-expanded={privacyOpen}><ShieldCheck size={17} /><span>Private by design</span><ChevronDown size={14} /></button></div>
      {privacyOpen && <section className="privacy-detail"><LockKeyhole size={20} /><div><h2>Your files are only here to be converted.</h2><p>Processing happens on this server. Originals are deleted after conversion, and results are deleted after download. Undownloaded files expire after {Math.round((cap?.limits.retentionMs || 900000) / 60000)} minutes. Closing this page requests deletion; expiry is the fallback if that request cannot finish. No file history or third-party processing.</p></div><button className="icon-button" aria-label="Close privacy information" onClick={() => setPrivacyOpen(false)}><X size={18} /></button></section>}
      <div role="alert" aria-live="assertive">{error && <div className="alert error"><CircleAlert size={18} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}</div>
      {view === 'formats' ? renderFormats() : <><section className="workspace" aria-label="File converter"><div className="file-workspace"><div className="workspace-toolbar"><div className="segmented" aria-label="Selection type"><button className={mode === 'files' ? 'selected' : ''} disabled={busy || !!job || downloaded} aria-pressed={mode === 'files'} onClick={() => setMode('files')}><File size={16} /> Files</button><button className={mode === 'folder' ? 'selected' : ''} disabled={busy || !!job || downloaded} aria-pressed={mode === 'folder'} onClick={() => setMode('folder')}><Folder size={16} /> Folder</button></div><span className="batch-note"><Layers2 size={14} /> Batch conversion</span></div>
          <input ref={fileInput} type="file" multiple hidden aria-label="Choose files to convert" onChange={event => { addFiles([...event.target.files || []].map(file => ({ file, path: file.name }))); event.target.value = ''; }} />
          <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '', directory: '' }} aria-label="Choose folder to convert" onChange={event => { addFiles([...event.target.files || []].map(file => ({ file, path: file.webkitRelativePath || file.name }))); event.target.value = ''; }} />
          {downloaded ? <div className="success-state"><div className="success-icon"><CheckCheck size={35} /></div><h2>All yours. All cleared.</h2><p>Your download is ready and the server copies have been deleted.</p><button className="button secondary" onClick={reset}><Plus size={17} /> Convert more files</button></div> : <>
          {!job && <div className={`dropzone ${dragging ? 'dragging' : ''} ${files.length ? 'compact' : ''}`} onDragEnter={event => { event.preventDefault(); dragDepth.current++; setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) setDragging(false); }} onDrop={drop}>
            {!files.length ? <><div className="upload-symbol"><FileImage className="upload-file-back" size={48} /><FileText className="upload-file-front" size={52} /><span><Upload size={19} /></span></div><h2>{reading ? 'Reading your folder…' : mode === 'folder' ? 'Drop your folder here' : 'Drop your files here'}</h2><p>or choose {mode === 'folder' ? 'a folder' : 'files'} from your device</p><button className="button primary choose-button" disabled={!cap || busy} onClick={() => selectFiles()}>{!cap || reading ? <LoaderCircle size={17} className="spin" /> : mode === 'folder' ? <FolderOpen size={18} /> : <Plus size={18} />}{!cap ? 'Connecting…' : mode === 'folder' ? 'Choose folder' : 'Choose files'}<ChevronRight size={16} /></button><span className="upload-limit">Up to 100 MB per file <span>·</span> 100 files per batch</span></> : <button className="text-button" disabled={busy} onClick={() => selectFiles()}><Plus size={17} /> Add more {mode === 'folder' ? 'folders' : 'files'} <span className="drop-hint">or drop them here</span></button>}
          </div>}
          {(files.length > 0 || job) && <div className="queue"><div className="queue-heading"><h2>{job ? terminal ? 'Conversion results' : 'Converting your files' : 'Your files'} <span>{files.length}</span></h2>{!busy && !job && <button className="text-button muted" onClick={() => setFiles([])}>Clear all</button>}{busy && <span className="queue-state"><LoaderCircle size={14} className="spin" />{uploading ? 'Uploading' : 'Processing'}</span>}</div><ul className="file-list">{files.map((item, index) => {
            const result = job?.files[index]; const category = cap?.formats[ext(item.path)]?.category; const Icon = categoryIcons[category || ''] || File; const outputs = cap?.formats[ext(item.path)]?.outputs || []; const missing = !outputs.length;
            return <li key={item.id} className={`file-row ${missing ? 'unsupported' : ''}`}><span className={`file-icon ${category || ''}`}><Icon size={21} /></span><div className="file-info"><span className="file-name" title={item.path}>{item.file.name}</span><span className="file-meta">{item.path.includes('/') ? `${item.path.substring(0, item.path.lastIndexOf('/'))} · ` : ''}{size(item.file.size)}{result?.status === 'done' && result.outputSize !== undefined ? ` → ${size(result.outputSize)}` : ''}</span>{missing && <span className="file-error">No converter available for {ext(item.path).toUpperCase() || 'this file type'}. Remove it to continue.</span>}{result?.error && <span className="file-error">{result.error}</span>}</div><div className="file-action">{!job ? <><ArrowRight size={14} className="file-arrow" /><label className="file-select"><span className="sr-only">Output format for {item.file.name}</span><select value={item.target} disabled={busy || missing} onChange={event => setFiles(files.map(file => file.id === item.id ? { ...file, target: event.target.value } : file))}>{missing ? <option value="">—</option> : outputs.map(output => <option value={output.format} key={output.format}>{output.format.toUpperCase()}</option>)}</select><ChevronDown size={12} /></label><button className="icon-button remove" aria-label={`Remove ${item.file.name}`} disabled={busy} onClick={() => setFiles(files.filter(file => file.id !== item.id))}><X size={16} /></button></> : result?.status === 'done' ? <button className="file-download" disabled={downloading} onClick={() => download(result)} aria-label={`Download ${item.file.name}`}><Check size={14} /><span>{item.target.toUpperCase()}</span><ArrowDownToLine size={15} /></button> : result?.status === 'downloaded' ? <span className="file-complete"><CheckCheck size={16} /> Saved</span> : result?.status === 'error' ? <CircleAlert size={18} className="failed-icon" /> : <LoaderCircle className={result?.status === 'converting' ? 'spin working-icon' : 'waiting-icon'} size={18} />}</div></li>;
          })}</ul><div className="queue-footer"><span>{files.length} {files.length === 1 ? 'file' : 'files'} <span>·</span> {size(total)} total</span>{files.some(item => item.path.includes('/')) && <span><Folder size={13} /> Folder structure kept in ZIP</span>}</div></div>}
          {busy && <div className="progress-area" role="status"><div className="progress-label"><span>{uploading ? uploadProgress === 100 ? 'Upload complete. Preparing your conversion…' : 'Uploading files…' : `${settled} of ${files.length} files processed`}</span><button className="text-button" onClick={reset}>Cancel & delete</button></div><div className="progress-track" role="progressbar" aria-label={uploading ? 'Upload progress' : 'Files processed'} aria-valuemin={0} aria-valuemax={uploading ? 100 : files.length} aria-valuenow={uploading ? uploadProgress || 0 : settled}><div style={{ width: `${uploading ? uploadProgress || 0 : settled / files.length * 100}%` }} /></div></div>}
          {terminal && <div className={`result-summary ${job?.status === 'error' ? 'has-errors' : ''}`} role="status">{successes.length ? <CheckCircle2 size={20} /> : <CircleAlert size={20} />}<div><strong>{successes.length ? `${successes.length} ${successes.length === 1 ? 'file is' : 'files are'} ready to go.` : 'These files could not be converted.'}</strong><p>{job?.status === 'partial' ? 'Download the successful files. Check the errors above for the others.' : successes.length ? 'Download your results before they expire. Each download clears its server copy.' : 'Check the errors above, then start a new conversion.'}</p></div><button className="icon-button" aria-label="Start a new conversion and delete these files" onClick={reset}><RotateCcw size={18} /></button></div>}
          </>}
          {notice && <p className="notice" role="status">{notice}</p>}
          {!files.length && !downloaded && <div className="category-strip"><span>Make room for any format</span><div>{[{ icon: Image, text: 'Images' }, { icon: FileText, text: 'Documents' }, { icon: Film, text: 'Video' }, { icon: Music2, text: 'Audio' }, { icon: Table2, text: 'Data' }].map(({ icon: Icon, text }) => <button key={text} onClick={() => { setSearch(text === 'Data' ? 'Data' : text); setView('formats'); }}><Icon size={15} />{text}</button>)}</div></div>}
        </div><aside className="conversion-settings"><div className="settings-heading"><SlidersHorizontal size={17} /><h2>Conversion settings</h2></div><div className="settings-body"><label className="field-label" htmlFor="output-format">Convert to</label><div className="format-select-wrap"><span className="format-icon"><FileText size={20} /></span><select id="output-format" value={format} onChange={event => applyFormat(event.target.value)} disabled={!cap || busy || !!job || downloaded}><option value="">Choose a format</option>{batchFormats.map(target => <option key={target} value={target}>{target.toUpperCase()} — {formatNames[target] || `${target.toUpperCase()} file`}</option>)}</select><ChevronDown size={16} /></div><p className="field-hint">{files.length ? 'Apply to compatible files. You can also choose a format for each file.' : 'Add your files to see compatible output formats.'}</p><div className="settings-divider" /><button className="options-toggle" onClick={() => setQualityOpen(!qualityOpen)} aria-expanded={qualityOpen}><span><SlidersHorizontal size={15} /> Output quality</span><span>{quality === 85 ? 'High' : `${quality}%`}<ChevronDown size={14} className={qualityOpen ? 'rotated' : ''} /></span></button>{qualityOpen && <div className="quality-options"><label htmlFor="quality">Image & video quality <strong>{quality}%</strong></label><input id="quality" type="range" min="40" max="100" value={quality} disabled={busy || !!job || downloaded} onChange={event => setQuality(Number(event.target.value))} /><div><span>Smaller file</span><span>Higher quality</span></div><p>Applies to lossy images and H.264 video. Other conversions use their original settings. Video-to-GIF output is limited to 30 seconds.</p></div>}<div className="settings-divider" /><div className="setting-fact"><Folder size={16} /><div><strong>Keep things organized</strong><p>Folder structure is preserved in your ZIP download.</p></div><Check size={15} /></div><div className="settings-summary"><span>{files.length ? `${files.length} ${files.length === 1 ? 'file' : 'files'} selected` : 'Ready when you are'}</span><span>{files.length ? size(total) : 'No account needed'}</span></div>{terminal && successes.length ? <button className="button primary convert-button" disabled={downloading} onClick={() => download()}>{downloading ? <LoaderCircle size={18} className="spin" /> : <ArrowDownToLine size={18} />}{downloading ? 'Downloading…' : `Download ${successes.length > 1 ? 'ZIP' : 'result as ZIP'}`}</button> : downloaded ? <button className="button primary convert-button" onClick={reset}><Plus size={17} /> New conversion</button> : terminal ? <button className="button primary convert-button" onClick={reset}><RotateCcw size={17} /> Try again</button> : <button className="button primary convert-button" disabled={!cap || !files.length || invalid.length > 0 || busy} onClick={convertFiles}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}{busy ? uploading ? 'Uploading…' : 'Converting…' : 'Convert files'}</button>}<span className="cta-hint"><LockKeyhole size={12} /> Temporary files. No history.</span></div><div className="privacy-note"><ShieldCheck size={20} /><div><strong>Your files stay yours.</strong><p>Server copies are cleared after download. Undownloaded results expire after {Math.round((cap?.limits.retentionMs || 900000) / 60000)} minutes.</p></div></div></aside></section><div className="below-workspace"><span><ShieldCheck size={15} /> Processed on this server</span><span><Check size={15} /> No sign-up, no extra steps</span><button onClick={() => { setSearch(''); setView('formats'); }}>Explore supported formats <ArrowUpRight size={14} /></button></div></>}
      <section className={`how-it-works ${helpOpen ? 'open' : ''}`} ref={helpRef}><button className="help-heading" onClick={() => setHelpOpen(!helpOpen)} aria-expanded={helpOpen}><h2>A little less file friction.</h2><span>How it works <ChevronDown size={16} /></span></button>{helpOpen && <div className="help-steps"><div><Upload size={21} /><h3>Bring your files</h3><p>Choose one or more files, or select a folder. You can drag and drop either into the workspace.</p></div><div><SlidersHorizontal size={21} /><h3>Pick a new format</h3><p>Choose a compatible output for each file, or apply the same format to compatible files in your batch.</p></div><div><ArrowDownToLine size={21} /><h3>Download and carry on</h3><p>Save files individually or as a ZIP. Downloads delete server copies; cancelling clears the whole batch.</p></div></div>}</section>
    </main><footer><span className="footer-brand">folio.</span><span>A small tool for your next big thing.</span><button onClick={() => { setPrivacyOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><LockKeyhole size={13} /> File privacy</button></footer>
  </div>;
}
