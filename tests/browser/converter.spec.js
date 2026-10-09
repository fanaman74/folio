import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import JSZip from 'jszip';

test('upload, per-file format, real conversion, download and cleared state', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/convert');
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeEnabled();
  await page.screenshot({ path: `test-results/${testInfo.project.name}-empty.png`, fullPage: true, animations: 'disabled' });
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.locator('body').evaluate(element => element.clientWidth));
  const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#5c8e69' } }).png().toBuffer();
  await page.getByLabel('Choose files to convert').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('sample.png', { exact: true })).toBeVisible();
  await page.getByLabel('Output format for sample.png').selectOption('webp');
  await page.getByRole('button', { name: 'Convert files', exact: true }).click();
  await expect(page.getByText('1 file is ready to go.')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `test-results/${testInfo.project.name}-results.png`, fullPage: true, animations: 'disabled' });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download sample.png' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('sample.webp');
  await expect(page.getByText('All yours. All cleared.')).toBeVisible();
  await page.getByRole('button', { name: 'Convert more files' }).click();
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a real folder selection converts nested files and downloads their paths in a ZIP', async ({ page }, testInfo) => {
  const directory = resolve(`test-results/fixtures-${testInfo.project.name}/reports`);
  await mkdir(join(directory, 'nested'), { recursive: true });
  await writeFile(join(directory, 'one.csv'), 'name,value\nAlpha,1\n');
  await writeFile(join(directory, 'nested', 'two.csv'), 'name,value\nBeta,2\n');
  try {
    await page.goto('/convert');
    await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Folder', exact: true }).click();
    await page.getByLabel('Choose folder to convert').setInputFiles(directory);
    await expect(page.getByText('one.csv', { exact: true })).toBeVisible();
    await expect(page.getByText('two.csv', { exact: true })).toBeVisible();
    await page.getByLabel('Convert to', { exact: true }).selectOption('json');
    await page.getByRole('button', { name: 'Convert files', exact: true }).click();
    await expect(page.getByText('2 files are ready to go.')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download ZIP', exact: true }).click();
    const download = await downloadPromise;
    const archive = await JSZip.loadAsync(await readFile(await download.path()));
    expect(archive.file('reports/one.json')).not.toBeNull();
    expect(archive.file('reports/nested/two.json')).not.toBeNull();
    await expect(page.getByText('All yours. All cleared.')).toBeVisible();
  } finally { await rm(resolve(`test-results/fixtures-${testInfo.project.name}`), { recursive: true, force: true }); }
});

test('folder picker, unsupported files, formats search, help and privacy', async ({ page }) => {
  await page.goto('/convert');
  await page.getByRole('button', { name: 'Folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose folder', exact: true })).toBeVisible();
  await expect(page.getByLabel('Choose folder to convert')).toHaveAttribute('webkitdirectory', '');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByLabel('Choose files to convert').setInputFiles({ name: 'unknown.xyz', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  await expect(page.getByText('No converter available for XYZ. Remove it to continue.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Convert files', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove unknown.xyz' }).click();
  await page.getByRole('button', { name: 'Supported formats', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search supported formats' }).fill('webp');
  await expect(page.getByRole('heading', { name: 'Images', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search supported formats' }).fill('not-a-real-format');
  await expect(page.getByText('No available conversions match')).toBeVisible();
  await page.getByRole('button', { name: 'Back to converter' }).click();
  await page.getByRole('button', { name: 'Private by design' }).click();
  await expect(page.getByRole('heading', { name: 'Your files are only here to be converted.' })).toBeVisible();
  await page.getByRole('button', { name: 'A little less file friction.' }).click();
  await expect(page.getByRole('heading', { name: 'Bring your files' })).toBeVisible();
});

test('intro page leads into the converter', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Your files. A fresh format.' })).toBeVisible();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.locator('body').evaluate(element => element.clientWidth));
  await page.screenshot({ path: `test-results/${testInfo.project.name}-intro.png`, animations: 'disabled' });
  await page.getByRole('link', { name: 'Start converting' }).click();
  await expect(page).toHaveURL(/\/convert$/);
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
