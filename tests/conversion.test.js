import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import ffmpeg from 'ffmpeg-static';
import { mkdtemp, rm, readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, safePath } from '../server/app.js';
import { createCatalog } from '../server/catalog.js';
import { run } from '../server/converters.js';

let service, root, image, catalog;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-test-'));
  let media = null;
  try { await access(ffmpeg); media = ffmpeg; } catch { /* Native media tests skip when the optional test binary is absent. */ }
  catalog = await createCatalog({ ffmpeg: media });
  service = await createApp({ catalog, tempRoot: join(root, 'jobs') });
  image = await sharp({ create: { width: 24, height: 18, channels: 4, background: '#5a8c68' } }).png().toBuffer();
});
after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });

async function submit(files) {
  let req = request(service.app).post('/api/jobs').field('manifest', JSON.stringify(files.map(file => ({ path: file.path, target: file.target })))).field('quality', '85');
  for (const file of files) req = req.attach('files', file.buffer, { filename: file.path.split('/').at(-1) });
  return req;
}
async function finished(id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(service.app).get(`/api/jobs/${id}`);
    assert.equal(response.status, 200);
    if (!['queued', 'converting'].includes(response.body.status)) return response.body;
    await delay(50);
  }
  throw new Error('Conversion did not finish in time.');
}
const binary = (res, callback) => { const parts = []; res.on('data', chunk => parts.push(chunk)); res.on('end', () => callback(null, Buffer.concat(parts))); };
async function removed(id) { for (let i = 0; i < 40 && service.jobs.has(id); i++) await delay(25); assert.equal(service.jobs.has(id), false); assert.equal((await readdir(service.root)).includes(`job-${id}`), false); }
async function empty(directory) { for (let i = 0; i < 60 && (await readdir(directory)).length; i++) await delay(25); assert.deepEqual(await readdir(directory), []); }

test('health and capability catalogue expose only installed converters', async () => {
  assert.equal((await request(service.app).get('/health')).body.status, 'ok');
  const response = await request(service.app).get('/api/capabilities');
  assert.match(response.headers['cache-control'], /no-store/);
  assert.ok(response.body.formats.png.outputs.some(output => output.format === 'webp'));
  assert.ok(!response.body.formats.png.outputs.some(output => output.format === 'docx'));
  assert.equal(response.body.engines.documents, !!catalog.engines.soffice);
  assert.equal(response.body.formats.docx !== undefined, !!catalog.engines.soffice);
});

test('real image conversion, individual download, then physical deletion', async () => {
  const response = await submit([{ path: 'photo.png', target: 'webp', buffer: image }]);
  assert.equal(response.status, 202, JSON.stringify(response.body));
  const job = await finished(response.body.id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  const internal = service.jobs.get(job.id).files[0];
  await assert.rejects(access(internal.input));
  const download = await request(service.app).get(`/api/jobs/${job.id}/files/0`).buffer(true).parse(binary);
  assert.equal(download.status, 200);
  assert.equal((await sharp(download.body).metadata()).format, 'webp');
  assert.match(download.headers['content-disposition'], /photo.webp/);
  await removed(job.id);
  assert.equal((await request(service.app).get(`/api/jobs/${job.id}`)).status, 410);
});

test('folder ZIP preserves paths and disambiguates output collisions', async () => {
  const response = await submit([{ path: 'holiday/photos/a.png', target: 'jpg', buffer: image }, { path: 'holiday/photos/a.webp', target: 'jpg', buffer: await sharp(image).webp().toBuffer() }, { path: 'holiday/data/people.csv', target: 'json', buffer: Buffer.from('name,age\nAda,36\n') }]);
  assert.equal(response.status, 202);
  const job = await finished(response.body.id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  const download = await request(service.app).get(`/api/jobs/${job.id}/download`).buffer(true).parse(binary);
  assert.equal(download.status, 200);
  const zip = await JSZip.loadAsync(download.body);
  assert.ok(zip.file('holiday/photos/a.jpg'));
  assert.ok(zip.file('holiday/photos/a (2).jpg'));
  assert.deepEqual(JSON.parse(await zip.file('holiday/data/people.json').async('string')), [{ name: 'Ada', age: '36' }]);
  await removed(job.id);
});

test('mixed valid and corrupt files allow successful results to be downloaded', async () => {
  const response = await submit([{ path: 'valid.png', target: 'jpg', buffer: image }, { path: 'broken.png', target: 'jpg', buffer: Buffer.from('PRIVATE_CONTENT_MUST_NOT_LEAK') }]);
  const job = await finished(response.body.id);
  assert.equal(job.status, 'partial');
  assert.equal(job.files[1].status, 'error');
  assert.ok(!JSON.stringify(job).includes('PRIVATE_CONTENT'));
  const download = await request(service.app).get(`/api/jobs/${job.id}/download`).buffer(true).parse(binary);
  assert.ok((await JSZip.loadAsync(download.body)).file('valid.jpg'));
  await removed(job.id);
});

test('rejects traversal paths, impossible conversions and malformed manifests; cleans rejected uploads', async () => {
  for (const path of ['../evil.png', '/evil.png', 'C:\\evil.png', 'ok/../../evil.png', 'folder/./evil.png']) {
    const response = await submit([{ path, target: 'jpg', buffer: image }]);
    assert.equal(response.status, 400);
  }
  assert.equal((await submit([{ path: 'photo.png', target: 'docx', buffer: image }])).status, 400);
  const response = await request(service.app).post('/api/jobs').field('manifest', '{broken').attach('files', image, 'photo.png');
  assert.equal(response.status, 400);
  await empty(service.root);
  assert.throws(() => safePath('folder/..\\file.png'));
});

test('XML entities are rejected and unsafe parser contents are not returned', async () => {
  // Fresh app avoids the intentionally strict public batch-creation rate limit.
  const alternate = await createApp({ catalog, tempRoot: join(root, 'xml') });
  try {
    const response = await request(alternate.app).post('/api/jobs').field('manifest', JSON.stringify([{ path: 'test.xml', target: 'json' }])).attach('files', Buffer.from('<!DOCTYPE root [<!ENTITY secret SYSTEM "file:///etc/passwd">]><root>&secret;</root>'), 'test.xml');
    await delay(100);
    const job = (await request(alternate.app).get(`/api/jobs/${response.body.id}`)).body;
    assert.equal(job.status, 'error');
    assert.match(job.files[0].error, /entities/);
  } finally { await alternate.close(); }
});

test('expiry and explicit discard physically remove files', async () => {
  const alternate = await createApp({ catalog, tempRoot: join(root, 'expiry'), limits: { retentionMs: 60_000, concurrency: 0 } });
  try {
    const send = () => request(alternate.app).post('/api/jobs').field('manifest', JSON.stringify([{ path: 'photo.png', target: 'jpg' }])).attach('files', image, 'photo.png');
    let response = await send();
    alternate.jobs.get(response.body.id).expiresAt = Date.now() - 1;
    await alternate.sweep();
    await empty(alternate.root);
    assert.equal((await request(alternate.app).get(`/api/jobs/${response.body.id}`)).status, 410);
    response = await send();
    assert.equal((await request(alternate.app).delete(`/api/jobs/${response.body.id}`)).status, 204);
    await empty(alternate.root);
  } finally { await alternate.close(); }
});

test('upload budget enforces streaming limits and removes temporary files', async () => {
  const alternate = await createApp({ catalog, tempRoot: join(root, 'limit'), limits: { maxTotalBytes: 10 } });
  try {
    const response = await request(alternate.app).post('/api/jobs').field('manifest', JSON.stringify([{ path: 'photo.png', target: 'jpg' }])).attach('files', image, 'photo.png');
    assert.equal(response.status, 413);
    await empty(alternate.root);
  } finally { await alternate.close(); }
});

test('real WAV-to-MP3 conversion through the native adapter', async context => {
  if (!catalog.engines.ffmpeg) { context.skip('Install the optional ffmpeg-static dev dependency or set FFMPEG_PATH.'); return; }
  const input = join(root, 'tone.wav');
  await run(catalog.engines.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', input]);
  const alternate = await createApp({ catalog, tempRoot: join(root, 'media') });
  try {
    const response = await request(alternate.app).post('/api/jobs').field('manifest', JSON.stringify([{ path: 'tone.wav', target: 'mp3' }])).attach('files', await readFile(input), 'tone.wav');
    let job;
    for (let i = 0; i < 60; i++) { job = (await request(alternate.app).get(`/api/jobs/${response.body.id}`)).body; if (job.status === 'done' || job.status === 'error') break; await delay(50); }
    assert.equal(job.status, 'done', JSON.stringify(job));
    const download = await request(alternate.app).get(`/api/jobs/${job.id}/files/0`).buffer(true).parse(binary);
    assert.equal(download.status, 200);
    assert.ok(download.body.length > 100);
    assert.match(download.headers['content-disposition'], /tone.mp3/);
  } finally { await alternate.close(); }
});

test('image-to-PDF creates a valid PDF with the image on its page', async () => {
  const alternate = await createApp({ catalog, tempRoot: join(root, 'image-pdf') });
  try {
    const response = await request(alternate.app).post('/api/jobs').field('manifest', JSON.stringify([{ path: 'photo.png', target: 'pdf' }])).attach('files', image, 'photo.png');
    let job;
    for (let i = 0; i < 60; i++) { job = (await request(alternate.app).get(`/api/jobs/${response.body.id}`)).body; if (job.status === 'done' || job.status === 'error') break; await delay(50); }
    assert.equal(job.status, 'done', JSON.stringify(job));
    const download = await request(alternate.app).get(`/api/jobs/${job.id}/files/0`).buffer(true).parse(binary);
    const pdf = await PDFDocument.load(download.body);
    assert.equal(pdf.getPageCount(), 1);
    assert.equal(pdf.getPage(0).getWidth(), 24);
    assert.equal(pdf.getPage(0).getHeight(), 18);
  } finally { await alternate.close(); }
});

test('native processes respond to cancellation', async context => {
  if (!catalog.engines.ffmpeg) { context.skip('Native FFmpeg not installed.'); return; }
  const controller = new AbortController();
  const task = run(catalog.engines.ffmpeg, ['-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'null', '-'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(task, /abort|cancel/i);
});
