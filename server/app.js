import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { ZipArchive } from 'archiver';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm as remove, readdir, stat } from 'node:fs/promises';
import { join, resolve, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCatalog, extension } from './catalog.js';
import { convert } from './converters.js';

const MB = 1024 * 1024;
const rm = (path, options = {}) => remove(path, { ...options, recursive: true, maxRetries: 8, retryDelay: 50 });
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\x00-\x1f\x7f:]/.test(value)) throw new Error('A filename is invalid. Rename it and try again.');
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (normalized.startsWith('/') || parts.length > 12 || parts.some(part => !part || part === '.' || part === '..' || /[<>"|?*]/.test(part))) throw new Error('A file path is invalid. Remove special characters and try again.');
  return parts.join('/');
}

export async function createApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Railway terminates TLS at one trusted reverse proxy.
  if (process.env.RAILWAY_ENVIRONMENT_ID) app.set('trust proxy', 1);
  const catalog = options.catalog || await createCatalog();
  const root = resolve(options.tempRoot || process.env.TEMP_DIR || join(tmpdir(), 'folio-converter'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Only remove this application's owned scratch directories; never follow paths from uploads.
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && /^job-[a-f0-9]{48}$/.test(entry.name)) await rm(join(root, entry.name), { recursive: true, force: true });
  const retention = Number(process.env.RETENTION_MINUTES || 15);
  if (!Number.isFinite(retention) || retention < 1 || retention > 60) throw new Error('RETENTION_MINUTES must be between 1 and 60.');
  const limits = { maxFiles: 100, maxFileBytes: 100 * MB, maxTotalBytes: 500 * MB, retentionMs: retention * 60_000, maxJobs: 8, concurrency: 2, ...options.limits };
  const jobs = new Map();
  const uploads = new Set();
  let active = 0;
  let closed = false;
  const processing = new Set();
  const apiError = (res, status, error) => res.status(status).json({ error });
  const clean = async job => {
    job.deleteRequested = true;
    try {
      await rm(job.dir, { recursive: true, force: true });
      jobs.delete(job.id);
    } catch {
      // Keep a deletion-only record so the sweeper retries transient disk errors.
      job.status = 'deleting';
    }
  };
  const snapshot = job => ({ id: job.id, status: job.status, expiresAt: job.expiresAt, files: job.files.map(({ input, output, work, ...file }) => file) });
  const lookup = (req, res, next) => {
    const job = jobs.get(req.params.id);
    if (!job || Date.now() >= job.expiresAt) return apiError(res, 410, 'These files have expired or were deleted. Select your files again.');
    req.job = job;
    next();
  };
  const boundDownload = (job, res) => {
    res.setTimeout(120_000, () => res.destroy());
    const expiry = setTimeout(() => res.destroy(), Math.max(1, job.expiresAt - Date.now()));
    expiry.unref();
    res.once('close', () => clearTimeout(expiry));
  };
  const processJob = async job => {
    active++;
    job.status = 'converting';
    try {
      for (const file of job.files) {
        if (job.controller.signal.aborted) break;
        file.status = 'converting';
        try {
          await convert({ input: file.input, output: file.output, work: file.work, from: file.from, to: file.target, engine: file.engine, quality: job.quality, signal: job.controller.signal, engines: catalog.engines });
          const { size } = await stat(file.output);
          job.outputBytes = (job.outputBytes || 0) + size;
          if (job.outputBytes > limits.maxTotalBytes) throw new Error('The converted file exceeds the output size limit. Try a smaller file.');
          file.outputSize = size;
          file.status = 'done';
        } catch (error) {
          file.status = 'error';
          // Safe product errors only: parser errors can contain uploaded content.
          const safe = /^(CSV and TSV|XML declarations|This XML|SVGs with|The conversion engine|Conversion |This document|The converted file)/.test(error.message);
          file.error = safe ? error.message : 'This file could not be converted. Check its contents and selected format, then try again.';
          await rm(file.output, { force: true });
        } finally {
          await rm(file.input, { force: true });
          await rm(file.work, { recursive: true, force: true });
        }
      }
      if (job.controller.signal.aborted) await clean(job);
      else job.status = job.files.every(file => file.status === 'done') ? 'done' : job.files.some(file => file.status === 'done') ? 'partial' : 'error';
    } finally { active--; pump(); }
  };
  const pump = () => {
    if (closed) return;
    for (const job of jobs.values()) {
      if (active >= limits.concurrency) break;
      if (job.status === 'queued') {
        const task = processJob(job);
        processing.add(task);
        task.catch(() => clean(job)).finally(() => processing.delete(task));
      }
    }
  };

  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'"], imgSrc: ["'self'", 'blob:', 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null } }, crossOriginEmbedderPolicy: false }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Wait a minute and try again.' } }));
  app.use('/api', (req, res, next) => {
    // Reject cross-site state-changing requests without trusting forwarded host headers.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('sec-fetch-site') === 'cross-site') return apiError(res, 403, 'Open Folio directly to convert files.');
    next();
  });
  app.get('/api/capabilities', (_req, res) => res.json({ formats: catalog.formats, categories: catalog.categories, engines: { images: true, data: true, documents: !!catalog.engines.soffice, media: !!catalog.engines.ffmpeg, ebooks: !!catalog.engines.pandoc }, limits }));
  const storage = {
    _handleFile(req, file, cb) {
      const ext = extension(file.originalname);
      const name = randomBytes(12).toString('hex') + (/^[a-z0-9]{1,10}$/.test(ext) ? `.${ext}` : '.bin');
      const path = join(req.uploadDir, name);
      let size = 0;
      const budget = new Transform({ transform(chunk, _encoding, callback) {
        req.uploadBytes += chunk.length;
        size += chunk.length;
        callback(req.uploadBytes > limits.maxTotalBytes ? new Error('The batch exceeds the total upload limit.') : null, chunk);
      } });
      pipeline(file.stream, budget, createWriteStream(path, { mode: 0o600 })).then(() => cb(null, { path, size, filename: name }), error => cb(error));
    },
    _removeFile(_req, file, cb) { rm(file.path, { force: true }).then(() => cb(null), cb); },
  };
  const upload = multer({ storage, limits: { fileSize: limits.maxFileBytes, files: limits.maxFiles, fields: 3, fieldSize: 128 * 1024, parts: limits.maxFiles + 3 } }).array('files', limits.maxFiles);
  app.post('/api/jobs', rateLimit({ windowMs: 60_000, limit: 10, message: { error: 'Please wait a minute before starting another batch.' } }), async (req, res) => {
    if (closed || jobs.size + uploads.size >= limits.maxJobs) return apiError(res, 503, 'The converter is busy. Try again shortly.');
    if (Number(req.get('content-length')) > limits.maxTotalBytes + MB) return apiError(res, 413, 'The batch exceeds the total upload limit.');
    const id = randomBytes(24).toString('hex');
    req.uploadDir = join(root, `job-${id}`);
    req.uploadBytes = 0;
    uploads.add(req.uploadDir);
    let accepted = false;
    try {
      await mkdir(req.uploadDir, { mode: 0o700 });
      await new Promise((yes, no) => upload(req, res, error => error ? no(error) : yes()));
      if (!req.files?.length) return apiError(res, 400, 'Select at least one file.');
      const manifest = JSON.parse(req.body.manifest || '[]');
      if (!Array.isArray(manifest) || manifest.length !== req.files.length) return apiError(res, 400, 'File selections did not match the upload. Select the files again.');
      const quality = Number(req.body.quality ?? 85);
      if (!Number.isInteger(quality) || quality < 40 || quality > 100) return apiError(res, 400, 'Quality must be between 40 and 100.');
      const names = new Set();
      const files = req.files.map((uploadFile, index) => {
        const item = manifest[index];
        const path = safePath(item?.path);
        const from = extension(path);
        if (extension(uploadFile.originalname) !== from) throw new Error('File selections did not match the upload. Select the files again.');
        const route = catalog.formats[from]?.outputs.find(output => output.format === item.target);
        if (!route) throw new Error(`A selected conversion is unavailable. Choose a supported format for every file.`);
        const base = path.slice(0, -(from.length + 1));
        let outputName = `${base}.${route.format}`;
        let suffix = 2;
        while (names.has(outputName.toLowerCase())) outputName = `${base} (${suffix++}).${route.format}`;
        names.add(outputName.toLowerCase());
        const work = join(req.uploadDir, `work-${index}`);
        if (route.engine === 'data' && uploadFile.size > 10 * MB) throw new Error('The batch contains a data file larger than 10 MB. Select a smaller data file.');
        return { id: String(index), path, name: posix.basename(path), from, target: route.format, engine: route.engine, size: uploadFile.size, status: 'queued', input: uploadFile.path, work, output: join(req.uploadDir, `${index}.${route.format}`), outputName };
      });
      const job = { id, dir: req.uploadDir, status: 'queued', files, quality, expiresAt: Date.now() + limits.retentionMs, controller: new AbortController(), downloading: false };
      jobs.set(id, job);
      accepted = true;
      res.status(202).json(snapshot(job));
      pump();
    } catch (error) {
      const allowed = /^(A filename|A file path|A selected conversion|File selections|The batch)/.test(error.message);
      apiError(res, error instanceof multer.MulterError || /limit/.test(error.message) ? 413 : 400, allowed ? error.message : error instanceof multer.MulterError ? 'The upload exceeds the file count or size limit. Select fewer or smaller files.' : 'The upload could not be read. Select your files again.');
    } finally {
      uploads.delete(req.uploadDir);
      if (!accepted) await rm(req.uploadDir, { recursive: true, force: true });
    }
  });
  app.get('/api/jobs/:id', lookup, (req, res) => res.json(snapshot(req.job)));
  app.delete('/api/jobs/:id', lookup, async (req, res) => {
    const job = req.job;
    job.controller.abort();
    if (job.status !== 'converting') await clean(job);
    res.status(204).end();
  });
  app.get('/api/jobs/:id/download', lookup, async (req, res) => {
    const job = req.job;
    if (!['done', 'partial'].includes(job.status)) return apiError(res, 409, 'Wait for conversion to finish before downloading.');
    const files = job.files.filter(file => file.status === 'done');
    if (!files.length) return apiError(res, 410, 'These files have already been downloaded and deleted.');
    if (job.downloading) return apiError(res, 409, 'A download is already running.');
    job.downloading = true;
    boundDownload(job, res);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    res.attachment('folio-converted.zip');
    res.on('finish', () => { void clean(job); });
    res.on('close', () => { archive.abort(); job.downloading = false; });
    archive.on('error', () => res.destroy());
    archive.pipe(res);
    for (const file of files) archive.file(file.output, { name: file.outputName });
    await archive.finalize();
  });
  app.get('/api/jobs/:id/files/:fileId', lookup, (req, res) => {
    const job = req.job;
    if (!['done', 'partial'].includes(job.status)) return apiError(res, 409, 'Wait for conversion to finish before downloading.');
    if (job.downloading) return apiError(res, 409, 'A download is already running.');
    const file = job.files.find(item => item.id === req.params.fileId && item.status === 'done');
    if (!file) return apiError(res, 410, 'This file is unavailable or has already been downloaded.');
    job.downloading = true;
    boundDownload(job, res);
    res.download(file.output, posix.basename(file.outputName), async error => {
      job.downloading = false;
      if (error) { if (!res.headersSent) apiError(res, 500, 'The download could not finish. Try again.'); return; }
      file.status = 'downloaded';
      await rm(file.output, { force: true });
      if (job.files.every(item => ['downloaded', 'error'].includes(item.status))) await clean(job);
    });
  });
  app.use('/api', (_req, res) => apiError(res, 404, 'This endpoint does not exist.'));
  const dist = resolve('dist');
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(join(dist, 'index.html')));
  app.use((error, _req, res, _next) => { if (!res.headersSent) apiError(res, 500, 'Something went wrong. Try again.'); });
  const sweep = async () => {
    for (const job of jobs.values()) if (job.deleteRequested || (Date.now() >= job.expiresAt && !job.downloading)) {
      job.controller.abort();
      if (job.status !== 'converting') await clean(job);
    }
  };
  const interval = setInterval(() => { void sweep(); }, Math.min(30_000, limits.retentionMs));
  interval.unref();
  const close = async () => {
    closed = true;
    clearInterval(interval);
    for (const job of jobs.values()) job.controller.abort();
    await Promise.allSettled([...processing]);
    await Promise.all([...jobs.values()].map(clean));
    await Promise.all([...uploads].map(dir => rm(dir, { recursive: true, force: true })));
  };
  return { app, close, sweep, jobs, root };
}
