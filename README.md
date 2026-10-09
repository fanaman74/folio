# Folio

A React + Node.js file converter designed with Impeccable. Select files or a folder, choose compatible formats, convert a batch, and download individual files or a ZIP with the original folder structure.

## Run locally

Requires Node.js 22.12 or later.

```sh
npm ci
npm run build
npm start
```

Open http://localhost:3001 for the intro page, or http://localhost:3001/convert for the converter. For development with live updates, use `npm run dev` and open http://localhost:5173.

Images and structured data work immediately. Native engines are detected from `PATH`. To enable media in the local preview using the test binary installed with the development dependencies, create `.env` with `FFMPEG_PATH` pointing to `node_modules/ffmpeg-static/ffmpeg.exe` on Windows, or its `ffmpeg` binary on Linux/macOS. Optional overrides are listed in `.env.example`. Do not copy a Windows executable path into Railway variables.

## Deploy to Railway — no Dockerfile

1. Push this repository to GitHub and create a Railway service from that repository.
2. Keep the service root at the repository root. Railway reads `railway.json` and builds with Railpack.
3. `railpack.json` installs FFmpeg, LibreOffice Writer/Calc/Impress, Poppler and fonts through Apt, plus the official Pandoc 3.8.3 binary through Mise. The official binary embeds its data files, which is required for sandboxed DOCX/EPUB conversions; Debian's Pandoc package does not. Build is `npm run build`; start is `npm start`; health check is `/health`. Railway supplies `PORT`.
4. Set `NODE_ENV=production`. Optionally set `RETENTION_MINUTES` to a number from 1 to 60 (default 15).
5. Use one service replica, no persistent volume, and no database. Generate a Railway domain and verify `/health` and `/api/capabilities` after the first deployment.

Railpack configuration follows the [official package installation guide](https://railpack.com/guides/installing-packages/); Railway's [configuration reference](https://docs.railway.com/config-as-code/reference) describes the service settings. Pandoc documents the embedded-data requirement for sandboxed writers in its [user guide](https://pandoc.org/MANUAL.html#general-options).

## Conversion coverage

The capability endpoint and UI show only routes whose engines are installed. A format's input support does not imply it can be converted into every other format.

| Category | Inputs | Outputs / engine |
| --- | --- | --- |
| Images | JPEG, PNG, WebP, AVIF, TIFF, GIF, SVG, depending on installed Sharp codecs | JPEG, PNG, WebP, AVIF, TIFF, GIF with Sharp; PDF with pdf-lib |
| Audio | MP3, WAV, FLAC, OGG, M4A, AAC, AIFF, Opus, WMA | MP3, WAV, FLAC, OGG, M4A, AAC, AIFF, Opus through FFmpeg |
| Video | MP4, MOV, MKV, WebM, AVI, M4V, MPEG, FLV, WMV, 3GP | MP4, WebM, MKV, MOV, GIF, or audio extraction through FFmpeg |
| Documents | DOC, DOCX, ODT, RTF, TXT | PDF, DOCX, ODT, RTF, TXT, HTML through LibreOffice |
| Spreadsheets | XLS, XLSX, ODS | PDF, XLSX, ODS, CSV through LibreOffice |
| Presentations | PPT, PPTX, ODP | PDF, PPTX, ODP through LibreOffice |
| E-books / markup | EPUB, Markdown, HTML, RST, LaTeX | EPUB, DOCX, HTML, Markdown, TXT through Pandoc |
| Structured data | CSV, TSV, JSON, YAML, XML | CSV, TSV, JSON, YAML, XML using native JavaScript libraries |
| PDF | PDF with a text layer | TXT through Poppler |

Important format behavior:

- Image-to-PDF uses the first frame/page of animated or multipage images, creating one PDF per selected file. It does not merge a batch into one PDF.
- Video-to-GIF is capped at 30 seconds and 640 pixels wide. Other media conversions preserve full duration.
- Image quality applies to lossy image encoders; video quality applies to H.264 outputs. Other encoders use their defaults.
- PDF-to-text does not perform OCR. PDF-to-Word, archives, CAD, proprietary project files, DRM-protected files, and unsupported codecs are not implemented. No finite converter can truthfully promise arbitrary all-to-all file conversion.
- CSV/TSV output requires tabular data: an array of objects, or XML `rows/row` elements. Nested values become JSON strings in cells. JSON-to-XML adds a root element. Encoding is UTF-8.
- LibreOffice layout depends on installed fonts. Pandoc runs with `--sandbox`, so referenced external images and resources are not fetched or embedded. Converted HTML is downloaded as an attachment, never rendered by the app.

## File lifecycle / ZDR

“ZDR” here is an application-level **no persistent file retention** policy, not a claim that conversion uses no temporary disk or that Railway has certified storage erasure.

- Browser selections and job identifiers remain in page memory; nothing is written to browser storage.
- Uploads use randomly named private scratch directories on ephemeral storage. No upload database, object store, history, telemetry SDK, or external conversion API is used. User filenames and conversion engine output are not logged by the application.
- Originals and engine workspaces are removed as each file finishes, including failed conversions.
- Individual downloads delete their converted server copy; a ZIP download deletes the entire batch after the response completes. Failed/interrupted downloads remain available until expiry or discard.
- Explicit cancellation/discard deletes the batch. Closing the page sends a best-effort discard request. Browser crashes and lost connections rely on expiry.
- All jobs expire after 15 minutes from upload acceptance by default. A sweep runs at most every 30 seconds, aborts active conversions, and deletes their files. Cleanup retries transient filesystem failures. Native engine timeouts are 3 minutes per file.
- Graceful shutdown aborts work and cleans scratch files. On startup, the application removes its own leftover job directories. No persistent Railway volume should be attached.
- Opaque random job URLs grant access to the active batch. API and download responses are `no-store`, and referrers are disabled. Treat live job URLs as secrets.

The host, reverse proxy, filesystem, backups and operational logging are outside this application's erasure guarantees. For strict organizational ZDR requirements, confirm Railway's storage and logging policies and choose the service region accordingly.

## Limits and deployment model

100 files per batch; 100 MB per file; 500 MB combined input and combined output; 10 MB per structured-data input. At most eight active/queued/uploading batches and two concurrently converting batches, with files processed sequentially within a batch. Limits and truthful completed-file progress are exposed to the UI.

Jobs live in memory, so this implementation uses one Railway replica. Restarting or redeploying deletes active jobs. Scaling horizontally requires job-aware routing and isolated workers; adding a shared persistent upload store would change the retention design.

This is a working single-service implementation. Native document/media parsers share the service's OS boundary; before opening an unrestricted high-traffic public deployment, add isolated workers with resource and outbound-network restrictions, abuse controls, and capacity monitoring. The current implementation includes upload budgets, rate limiting, explicit format allowlists, shell-free subprocess calls, macro restrictions, Pandoc sandboxing, FFmpeg protocol restrictions, safe archive paths and decoder timeouts.

## Verify

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:deployment -- https://YOUR-SERVICE.up.railway.app
```

Integration tests verify real image/data/audio conversions, folder-preserving ZIPs, collision handling, partial errors, streaming upload limits, traversal rejection, XML entity rejection, discard and physical file deletion. Browser tests run desktop and mobile file selection, format selection, conversion, downloads, unsupported-file handling and help/privacy flows. The deployment smoke test uploads synthetic files to verify image, data, Office, e-book, PDF text extraction and media conversions on Railway, downloads and checks their results, and confirms the batch is no longer accessible after download.

## Extend the backend

`server/catalog.js` defines input/output routes and engine availability. `server/converters.js` implements the adapter contract: `{ input, output, work, from, to, engine, quality, signal, engines }`. Add an engine by discovering its executable, declaring only meaningful routes, and implementing the adapter with cancellation and timeouts. `server/app.js` owns uploads, job scheduling, downloads and deletion independently of the converter. The browser consumes the catalogue without needing hard-coded conversion routes.

API: `GET /health`, `GET /api/capabilities`, multipart `POST /api/jobs` (`files`, JSON `manifest`, `quality`), `GET /api/jobs/:id`, `DELETE /api/jobs/:id`, `GET /api/jobs/:id/files/:fileId`, and `GET /api/jobs/:id/download`.
# document-convertor
