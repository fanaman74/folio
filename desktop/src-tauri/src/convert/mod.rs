//! File-to-PDF conversion. Every conversion runs on this computer.
//!
//! Built-in engines (always available, bundled in the app):
//! - `image`: raster images become one page each.
//! - `text`: plain text, source code, Markdown, HTML, CSV/TSV, spreadsheets and Word
//!   documents are typeset with bundled fonts.
//!
//! LibreOffice (optional, detected at runtime) gives full-fidelity output for
//! office formats and handles formats the built-in engines cannot read.

mod docx;
mod image_pdf;
pub mod merge;
mod office;
mod slim;
mod text;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PageSize {
    A4,
    Letter,
    Legal,
    A3,
    A5,
}

impl PageSize {
    /// Portrait width and height in millimetres.
    pub fn mm(self) -> (f32, f32) {
        match self {
            PageSize::A4 => (210.0, 297.0),
            PageSize::Letter => (215.9, 279.4),
            PageSize::Legal => (215.9, 355.6),
            PageSize::A3 => (297.0, 420.0),
            PageSize::A5 => (148.0, 210.0),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Auto,
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFit {
    /// Scale the image to fit the chosen page size.
    Fit,
    /// Make the page the size of the image (96 dpi).
    Original,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOptions {
    pub page_size: PageSize,
    pub orientation: Orientation,
    pub margin_mm: f32,
    pub image_fit: ImageFit,
    /// Folder for the PDF. `None` writes next to the source file.
    pub output_dir: Option<String>,
    /// Use LibreOffice for office formats when it is installed.
    pub prefer_libreoffice: bool,
}

impl ConvertOptions {
    /// Page size in millimetres after applying the orientation.
    /// `wide` says whether the content would prefer a landscape page.
    pub fn page_mm(&self, wide: bool) -> (f32, f32) {
        let (w, h) = self.page_size.mm();
        let landscape = match self.orientation {
            Orientation::Auto => wide,
            Orientation::Portrait => false,
            Orientation::Landscape => true,
        };
        if landscape { (h, w) } else { (w, h) }
    }

    pub fn margin(&self) -> f32 {
        self.margin_mm.clamp(0.0, 50.0)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOutcome {
    pub output: String,
    pub engine: &'static str,
    pub pages: Option<u32>,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub libreoffice: Option<String>,
    pub builtin: Vec<&'static str>,
    pub libreoffice_only: Vec<&'static str>,
}

pub const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "ico", "tga", "pnm", "pbm", "pgm", "ppm", "qoi"];
pub const MARKDOWN_EXT: &[&str] = &["md", "markdown", "mdown", "mkd"];
pub const HTML_EXT: &[&str] = &["html", "htm", "xhtml"];
pub const TABLE_EXT: &[&str] = &["csv", "tsv"];
pub const SHEET_EXT: &[&str] = &["xlsx", "xlsm", "xlsb", "xls", "ods"];
pub const DOCX_EXT: &[&str] = &["docx"];
pub const PLAIN_EXT: &[&str] = &[
    "txt", "text", "log", "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "rs", "js", "mjs", "cjs", "ts",
    "tsx", "jsx", "py", "rb", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cc", "cs", "php", "sh", "bash", "zsh",
    "ps1", "bat", "sql", "css", "scss", "less", "vue", "svelte", "lua", "r", "pl", "dart", "scala", "tex", "srt", "vtt",
];
/// Formats only LibreOffice can read.
pub const OFFICE_ONLY_EXT: &[&str] = &[
    "doc", "odt", "rtf", "wpd", "pages", "ppt", "pptx", "pps", "ppsx", "odp", "key", "odg", "vsd", "vsdx", "svg", "pub", "fodt",
    "fods", "fodp", "numbers", "dbf",
];

pub fn extension(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase()
}

pub fn engine_status() -> EngineStatus {
    let builtin = [IMAGE_EXT, MARKDOWN_EXT, HTML_EXT, TABLE_EXT, SHEET_EXT, DOCX_EXT, PLAIN_EXT].concat();
    EngineStatus {
        libreoffice: office::find_soffice().map(|p| p.to_string_lossy().into_owned()),
        builtin,
        libreoffice_only: OFFICE_ONLY_EXT.to_vec(),
    }
}

/// Picks a free `name.pdf` (or `name (2).pdf`, ...) in the output folder.
fn output_path(input: &Path, options: &ConvertOptions) -> Result<PathBuf> {
    let dir = match &options.output_dir {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => input.parent().map(Path::to_path_buf).context("The file has no folder to write into.")?,
    };
    std::fs::create_dir_all(&dir).with_context(|| format!("Could not create the folder {}", dir.display()))?;
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("document");
    let mut candidate = dir.join(format!("{stem}.pdf"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).pdf"));
        n += 1;
    }
    Ok(candidate)
}

pub fn convert_file(input: PathBuf, options: &ConvertOptions) -> Result<ConvertOutcome> {
    let meta = std::fs::metadata(&input).with_context(|| format!("Could not open {}", input.display()))?;
    if !meta.is_file() {
        bail!("Only files can be converted. Folders are not supported.");
    }
    let ext = extension(&input);
    if ext == "pdf" {
        bail!("This file is already a PDF.");
    }
    let is = |list: &[&str]| list.contains(&ext.as_str());
    let soffice = if options.prefer_libreoffice { office::find_soffice() } else { None };
    let office_capable = is(SHEET_EXT) || is(DOCX_EXT) || is(HTML_EXT) || is(OFFICE_ONLY_EXT);

    let output = output_path(&input, options)?;
    let result = (|| -> Result<&'static str> {
    Ok(if is(OFFICE_ONLY_EXT) || (office_capable && soffice.is_some()) {
        let soffice = soffice.or_else(office::find_soffice).with_context(|| {
            format!(".{ext} files need LibreOffice. Install it from libreoffice.org, then restart Folio.")
        })?;
        office::convert(&soffice, &input, &output)?;
        "LibreOffice"
    } else if is(IMAGE_EXT) {
        image_pdf::convert(&input, &output, options)?;
        "Built-in image"
    } else if is(MARKDOWN_EXT) {
        text::markdown(&input, &output, options)?;
        "Built-in Markdown"
    } else if is(HTML_EXT) {
        text::html(&input, &output, options)?;
        "Built-in HTML"
    } else if is(TABLE_EXT) {
        text::delimited(&input, &output, options, if ext == "tsv" { b'\t' } else { b',' })?;
        "Built-in table"
    } else if is(SHEET_EXT) {
        text::spreadsheet(&input, &output, options)?;
        "Built-in spreadsheet"
    } else if is(DOCX_EXT) {
        docx::convert(&input, &output, options)?;
        "Built-in Word"
    } else if is(PLAIN_EXT) || looks_like_text(&input) {
        text::plain(&input, &output, options)?;
        "Built-in text"
    } else {
        bail!("Folio can't convert .{ext} files yet.");
    })
    })();
    let engine = match result {
        Ok(engine) => engine,
        Err(error) => {
            // Never leave a half-written PDF behind.
            let _ = std::fs::remove_file(&output);
            return Err(error);
        }
    };

    let bytes = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    let pages = lopdf::Document::load(&output).ok().map(|doc| doc.get_pages().len() as u32);
    Ok(ConvertOutcome { output: output.to_string_lossy().into_owned(), engine, pages, bytes })
}

/// Treats unknown extensions as text when the first 8 KB is valid UTF-8 with no NUL bytes.
fn looks_like_text(path: &Path) -> bool {
    use std::io::Read;
    let mut buf = vec![0u8; 8192];
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let Ok(n) = file.read(&mut buf) else { return false };
    let slice = &buf[..n];
    n > 0 && !slice.contains(&0) && (std::str::from_utf8(slice).is_ok() || matches!(std::str::from_utf8(slice), Err(e) if e.error_len().is_none()))
}

#[cfg(test)]
mod tests;
