import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import sharp from 'sharp';

export const groups = {
  images: { label: 'Images', inputs: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif', 'svg'], outputs: ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'pdf'] },
  video: { label: 'Video', inputs: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpeg', 'mpg', 'flv', 'wmv', '3gp'], outputs: ['mp4', 'webm', 'mkv', 'mov', 'gif', 'mp3', 'wav', 'flac', 'ogg', 'm4a'] },
  audio: { label: 'Audio', inputs: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'aiff', 'aif', 'opus', 'wma'], outputs: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'aiff', 'opus'] },
  documents: { label: 'Documents', inputs: ['doc', 'docx', 'odt', 'rtf', 'txt'], outputs: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html'] },
  spreadsheets: { label: 'Spreadsheets', inputs: ['xls', 'xlsx', 'ods'], outputs: ['pdf', 'xlsx', 'ods', 'csv'] },
  presentations: { label: 'Presentations', inputs: ['ppt', 'pptx', 'odp'], outputs: ['pdf', 'pptx', 'odp'] },
  ebooks: { label: 'E-books & markup', inputs: ['epub', 'md', 'html', 'htm', 'rst', 'tex'], outputs: ['epub', 'docx', 'html', 'md', 'txt'] },
  data: { label: 'Data', inputs: ['csv', 'tsv', 'json', 'yaml', 'yml', 'xml'], outputs: ['csv', 'tsv', 'json', 'yaml', 'xml'] },
  pdf: { label: 'PDF', inputs: ['pdf'], outputs: ['txt'] },
};

export function extension(name) {
  return String(name).split(/[\\/]/).at(-1).split('.').slice(1).at(-1)?.toLowerCase() || '';
}

export async function findExecutable(configured, candidates) {
  if (configured) candidates = [configured];
  const dirs = (process.env.PATH || '').split(delimiter);
  for (const candidate of candidates) {
    for (const file of candidate.includes('/') || candidate.includes('\\') ? [candidate] : dirs.flatMap(dir => process.platform === 'win32' ? [join(dir, `${candidate}.exe`), join(dir, candidate)] : [join(dir, candidate)])) {
      try { await access(file, constants.X_OK); return resolve(file); } catch { /* Try the next installed location. */ }
    }
  }
  return null;
}

export async function createCatalog(overrides = {}) {
  const [ffmpeg, soffice, pandoc, pdftotext] = await Promise.all([
    findExecutable(process.env.FFMPEG_PATH, ['ffmpeg']),
    findExecutable(process.env.LIBREOFFICE_PATH, ['soffice', 'libreoffice', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe']),
    findExecutable(process.env.PANDOC_PATH, ['pandoc']),
    findExecutable(process.env.PDFTOTEXT_PATH, ['pdftotext']),
  ]);
  const engines = { ffmpeg, soffice, pandoc, pdftotext, ...overrides };
  const formats = {};
  const add = (input, target, engine, category) => {
    if (input === target) return;
    formats[input] ??= { category, outputs: [] };
    if (!formats[input].outputs.some(option => option.format === target)) formats[input].outputs.push({ format: target, engine });
  };
  const imageName = name => ({ jpg: 'jpeg', tif: 'tiff', avif: 'heif' }[name] || name);
  for (const input of groups.images.inputs) for (const target of groups.images.outputs) {
    if (sharp.format[imageName(input)]?.input.file && sharp.format[imageName(target)]?.output.file) add(input, target, 'sharp', 'images');
  }
  for (const input of groups.images.inputs) if (sharp.format[imageName(input)]?.input.file) add(input, 'pdf', 'image-pdf', 'images');
  if (engines.pdftotext) add('pdf', 'txt', 'pdftotext', 'pdf');
  for (const category of ['video', 'audio']) if (engines.ffmpeg) {
    for (const input of groups[category].inputs) for (const target of groups[category].outputs) add(input, target, 'ffmpeg', category);
  }
  for (const category of ['documents', 'spreadsheets', 'presentations']) if (engines.soffice) {
    for (const input of groups[category].inputs) for (const target of groups[category].outputs) add(input, target, 'soffice', category);
  }
  if (engines.pandoc) for (const input of groups.ebooks.inputs) for (const target of groups.ebooks.outputs) add(input, target, 'pandoc', 'ebooks');
  for (const input of groups.data.inputs) for (const target of groups.data.outputs) add(input, target, 'data', 'data');
  return { engines, formats, categories: Object.entries(groups).map(([id, group]) => ({ id, ...group, available: group.inputs.some(input => formats[input]?.outputs.length) })) };
}
