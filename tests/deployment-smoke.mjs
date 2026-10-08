import assert from 'node:assert/strict';
import sharp from 'sharp';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.argv[2];
if (!base?.startsWith('https://') || !new URL(base).hostname.endsWith('.up.railway.app')) throw new Error('Provide the verified Railway service URL.');
const get = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
  return response;
};
console.log('Health:', await (await get('/health')).json());
const capabilities = await (await get('/api/capabilities')).json();
console.log('Installed engines:', capabilities.engines);
const docx = new JSZip();
docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
docx.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
docx.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Folio Railway office smoke test.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
const pdf = await PDFDocument.create();
pdf.addPage().drawText('Folio PDF extraction smoke test.', { x: 40, y: 700, size: 16, font: await pdf.embedFont(StandardFonts.Helvetica) });
const wave = Buffer.alloc(44 + 16000 * 2 / 5);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
for (let i = 0; i < (wave.length - 44) / 2; i++) wave.writeInt16LE(Math.round(6000 * Math.sin(i * 440 * 2 * Math.PI / 16000)), 44 + i * 2);
const files = [
  { path: 'railway-check/image.png', target: 'webp', buffer: await sharp({ create: { width: 24, height: 18, channels: 3, background: '#285c46' } }).png().toBuffer() },
  { path: 'railway-check/data.csv', target: 'json', buffer: Buffer.from('name,value\nFolio,42\n') },
  { path: 'railway-check/document.docx', target: 'pdf', buffer: await docx.generateAsync({ type: 'nodebuffer' }) },
  { path: 'railway-check/notes.md', target: 'docx', buffer: Buffer.from('# Folio e-book engine test\n\nSynthetic deployment check.') },
  { path: 'railway-check/book.md', target: 'epub', buffer: Buffer.from('# Folio EPUB test\n\nSynthetic deployment check.') },
  { path: 'railway-check/page.md', target: 'html', buffer: Buffer.from('# Folio HTML test\n\nSynthetic deployment check.') },
  { path: 'railway-check/extract.pdf', target: 'txt', buffer: Buffer.from(await pdf.save()) },
  { path: 'railway-check/tone.wav', target: 'mp3', buffer: wave },
];
for (const file of files) assert.ok(capabilities.formats[file.path.split('.').at(-1)]?.outputs.some(output => output.format === file.target), `Missing route: ${file.path} to ${file.target}`);
const body = new FormData();
body.append('manifest', JSON.stringify(files.map(({ path, target }) => ({ path, target }))));
body.append('quality', '85');
for (const file of files) body.append('files', new Blob([file.buffer]), file.path.split('/').at(-1));
const job = await (await get('/api/jobs', { method: 'POST', body })).json();
try {
  let result;
  for (let i = 0; i < 90; i++) {
    result = await (await get(`/api/jobs/${job.id}`)).json();
    if (!['queued', 'converting'].includes(result.status)) break;
    if (i % 10 === 0) console.log('Processing:', result.files.map(file => `${file.name}: ${file.status}`).join(', '));
    await delay(1000);
  }
  console.log('Results:', result.files.map(file => ({ name: file.name, status: file.status, error: file.error })));
  assert.equal(result.status, 'done');
  const zip = await JSZip.loadAsync(await (await get(`/api/jobs/${job.id}/download`)).arrayBuffer());
  assert.equal((await sharp(await zip.file('railway-check/image.webp').async('nodebuffer')).metadata()).format, 'webp');
  assert.deepEqual(JSON.parse(await zip.file('railway-check/data.json').async('string')), [{ name: 'Folio', value: '42' }]);
  assert.ok((await PDFDocument.load(await zip.file('railway-check/document.pdf').async('nodebuffer'))).getPageCount() > 0);
  assert.ok((await JSZip.loadAsync(await zip.file('railway-check/notes.docx').async('nodebuffer'))).file('word/document.xml'));
  const epub = await JSZip.loadAsync(await zip.file('railway-check/book.epub').async('nodebuffer'));
  assert.equal(await epub.file('mimetype').async('string'), 'application/epub+zip');
  assert.match(await zip.file('railway-check/page.html').async('string'), /Folio HTML test/);
  assert.match(await zip.file('railway-check/extract.txt').async('string'), /Folio PDF extraction smoke test/);
  assert.ok((await zip.file('railway-check/tone.mp3').async('nodebuffer')).length > 100);
  let deleted;
  for (let i = 0; i < 10; i++) { deleted = await fetch(`${base}/api/jobs/${job.id}`); if (deleted.status === 410) break; await delay(200); }
  assert.equal(deleted.status, 410);
  console.log('PASS: all eight conversions produced valid downloads, and the downloaded batch was deleted.');
} finally { await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {}); }
