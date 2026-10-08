import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as stringifyCsv } from 'csv-stringify/sync';
import YAML from 'yaml';
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import { PDFDocument } from 'pdf-lib';

// libvips' file cache can retain original file descriptors after conversion.
// Disable it both for deletion on Windows and to avoid retaining pixel data.
sharp.cache(false);
sharp.concurrency(2);

export function run(binary, args, { signal, cwd, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, args, { shell: false, windowsHide: true, cwd, signal, stdio: ['ignore', 'ignore', 'pipe'] });
    // Decoder output may contain user data. Never log or return it.
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, killed) => {
      clearTimeout(timer);
      if (signal?.aborted) reject(new Error('Conversion cancelled.'));
      else if (killed) reject(new Error('Conversion exceeded its time limit. Try a smaller file.'));
      else if (code !== 0) reject(new Error('The conversion engine could not read this file. Check that it is valid and unencrypted.'));
      else resolve();
    });
  });
}

function tableRows(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.rows?.row) ? value.rows.row : value?.rows?.row ? [value.rows.row] : null;
  if (!rows || rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) throw new Error('CSV and TSV output needs an array of objects, or XML with rows/row elements.');
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, item]) => [key, typeof item === 'object' && item !== null ? JSON.stringify(item) : item])));
}

export async function convertData(input, output, from, to) {
  const source = await readFile(input, 'utf8');
  let value;
  if (['csv', 'tsv'].includes(from)) value = parseCsv(source, { columns: true, bom: true, delimiter: from === 'tsv' ? '\t' : ',', skip_empty_lines: true });
  else if (from === 'json') value = JSON.parse(source);
  else if (['yml', 'yaml'].includes(from)) value = YAML.parse(source, { maxAliasCount: 50 });
  else {
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('XML declarations with entities are not supported. Remove the DOCTYPE and try again.');
    if (XMLValidator.validate(source) !== true) throw new Error('This XML is not valid. Check its structure and try again.');
    value = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(source);
  }
  let result;
  if (to === 'json') result = JSON.stringify(value, null, 2);
  else if (to === 'yaml') result = YAML.stringify(value);
  else if (to === 'xml') {
    result = new XMLBuilder({ format: true, ignoreAttributes: false }).build(Array.isArray(value) ? { rows: { row: value } } : { root: value });
    if (XMLValidator.validate(result) !== true) throw new Error('This XML output needs valid element names. Remove spaces and special characters from your data keys.');
  }
  else {
    const rows = tableRows(value);
    const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
    result = rows.length ? stringifyCsv(rows, { header: true, columns, delimiter: to === 'tsv' ? '\t' : ',' }) : '';
  }
  await writeFile(output, result ?? 'null');
}

export async function convert({ input, output, work, from, to, engine, quality = 85, signal, engines }) {
  signal?.throwIfAborted();
  await mkdir(dirname(output), { recursive: true });
  if (engine === 'sharp' || engine === 'image-pdf') {
    if (from === 'svg') {
      const svg = await readFile(input, 'utf8');
      if (/<!DOCTYPE|<!ENTITY|@import|href\s*=\s*["'](?!#|data:)|url\s*\(\s*["']?(?!#|data:)/i.test(svg)) throw new Error('SVGs with external resources are not supported. Embed the resources and try again.');
    }
    const image = sharp(input, { animated: engine !== 'image-pdf' && ['gif', 'webp'].includes(from), limitInputPixels: 40_000_000 });
    const abort = () => image.destroy(new Error('Conversion cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      let pipeline = image.rotate().timeout({ seconds: 90 });
      if (to === 'jpg') pipeline = pipeline.flatten({ background: '#ffffff' });
      if (engine === 'image-pdf') {
        const png = await pipeline.png().toBuffer();
        const document = await PDFDocument.create();
        const embedded = await document.embedPng(png);
        const page = document.addPage([embedded.width, embedded.height]);
        page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
        await writeFile(output, await document.save());
      } else await pipeline.toFormat(to === 'jpg' ? 'jpeg' : to, { quality, effort: 4 }).toFile(output);
    } finally { signal?.removeEventListener('abort', abort); image.destroy(); }
  } else if (engine === 'data') {
    await convertData(input, output, from, to);
  } else if (engine === 'pdftotext') {
    await run(engines.pdftotext, ['-layout', '-enc', 'UTF-8', input, output], { signal, cwd: dirname(input) });
  } else if (engine === 'ffmpeg') {
    const demuxers = { mp4: 'mov', mov: 'mov', m4v: 'mov', m4a: 'mov', '3gp': 'mov', mkv: 'matroska', webm: 'matroska', avi: 'avi', mpeg: 'mpeg', mpg: 'mpeg', flv: 'flv', wmv: 'asf', wma: 'asf', mp3: 'mp3', wav: 'wav', flac: 'flac', ogg: 'ogg', opus: 'ogg', aac: 'aac', aiff: 'aiff', aif: 'aiff' };
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file', '-f', demuxers[from], '-threads', '2', '-i', input];
    if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'aiff', 'opus'].includes(to)) args.push('-vn');
    if (['mp4', 'mkv', 'mov'].includes(to)) args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', String(Math.round(35 - quality * 0.15)), '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac');
    if (to === 'webm') args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-c:a', 'libopus');
    if (to === 'gif') args.push('-vf', 'fps=12,scale=640:-1:flags=lanczos', '-t', '30');
    args.push('-threads', '2', '-fs', String(500 * 1024 * 1024 + 1), output);
    await run(engines.ffmpeg, args, { signal, cwd: dirname(input) });
  } else if (engine === 'soffice') {
    const outDir = join(work, 'office');
    const profile = join(work, 'office-profile');
    await mkdir(outDir, { recursive: true });
    await mkdir(profile, { recursive: true });
    // Disable macro execution and automatic link updates in each isolated profile.
    await mkdir(join(profile, 'user'), { recursive: true });
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>');
    const filter = to === 'txt' ? 'txt:Text' : to === 'csv' ? 'csv:Text - txt - csv (StarCalc)' : to;
    await run(engines.soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--nodefault', '--nofirststartwizard', '--convert-to', filter, '--outdir', outDir, input], { signal, cwd: dirname(input) });
    const result = (await readdir(outDir)).find(file => file.endsWith(`.${to}`));
    if (!result) throw new Error('This document could not be converted. Check that it is valid and unencrypted.');
    await rename(join(outDir, result), output);
  } else if (engine === 'pandoc') {
    const names = { md: 'commonmark', txt: 'plain', htm: 'html', tex: 'latex' };
    await run(engines.pandoc, ['+RTS', '-M512M', '-RTS', '--sandbox', '--standalone', '--from', names[from] || from, '--to', names[to] || to, '--output', output, basename(input)], { signal, cwd: dirname(input) });
  } else throw new Error('This conversion engine is unavailable.');
  signal?.throwIfAborted();
}
