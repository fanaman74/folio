//! Typesets text-like files (plain text, Markdown, HTML, tables, spreadsheets)
//! into PDF with bundled fonts.

use super::ConvertOptions;
use anyhow::{Context, Result};
use genpdf::elements::{Break, FrameCellDecorator, PageBreak, Paragraph, TableLayout};
use genpdf::fonts::{Font, FontData, FontFamily};
use genpdf::style::{Color, Style, StyledString};
use genpdf::{Alignment, Element, Mm};
use std::path::Path;

const SANS: [&[u8]; 4] = [
    include_bytes!("../../fonts/LiberationSans-Regular.ttf"),
    include_bytes!("../../fonts/LiberationSans-Bold.ttf"),
    include_bytes!("../../fonts/LiberationSans-Italic.ttf"),
    include_bytes!("../../fonts/LiberationSans-BoldItalic.ttf"),
];
const MONO: [&[u8]; 4] = [
    include_bytes!("../../fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("../../fonts/JetBrainsMono-Bold.ttf"),
    include_bytes!("../../fonts/JetBrainsMono-Italic.ttf"),
    include_bytes!("../../fonts/JetBrainsMono-BoldItalic.ttf"),
];

fn family(files: [&[u8]; 4]) -> Result<FontFamily<FontData>> {
    let load = |bytes: &[u8]| FontData::new(bytes.to_vec(), None).map_err(|e| anyhow::anyhow!("Bundled font failed to load: {e}"));
    Ok(FontFamily { regular: load(files[0])?, bold: load(files[1])?, italic: load(files[2])?, bold_italic: load(files[3])? })
}

pub const INK: Color = Color::Rgb(23, 20, 18);
pub const MUTED: Color = Color::Rgb(99, 91, 79);

/// A document plus what is needed to measure text before it is laid out.
pub struct Typesetter {
    doc: genpdf::Document,
    /// Monospace family; `None` when the document only uses the sans family,
    /// which keeps unused fonts out of the PDF.
    mono: Option<FontFamily<Font>>,
    /// Usable text width.
    pub width: Mm,
    pub base_size: u8,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Fonts {
    Sans,
    SansAndMono,
    Mono,
}

impl Typesetter {
    pub fn new(title: &str, options: &ConvertOptions, wide: bool, fonts: Fonts, base_size: u8) -> Result<Self> {
        let (default, mono_data) = match fonts {
            Fonts::Sans => (family(SANS)?, None),
            Fonts::SansAndMono => (family(SANS)?, Some(family(MONO)?)),
            Fonts::Mono => (family(MONO)?, None),
        };
        let mut doc = genpdf::Document::new(default);
        let mono = match (fonts, mono_data) {
            (Fonts::Mono, _) => Some(doc.font_cache().default_font_family()),
            (_, Some(data)) => Some(doc.add_font_family(data)),
            _ => None,
        };
        let (pw, ph) = options.page_mm(wide);
        let margin = options.margin().max(5.0);
        doc.set_title(title);
        doc.set_paper_size(genpdf::Size::new(pw, ph));
        doc.set_font_size(base_size);
        doc.set_line_spacing(1.3);
        doc.set_minimal_conformance();
        let mut deco = genpdf::SimplePageDecorator::new();
        deco.set_margins(margin);
        let header = title.to_string();
        deco.set_header(move |page| {
            Paragraph::new(StyledString::new(format!("{header}  ·  {page}"), Style::new().with_font_size(7).with_color(MUTED)))
                .aligned(Alignment::Right)
                .padded(genpdf::Margins::trbl(0, 0, 4, 0))
        });
        doc.set_page_decorator(deco);
        Ok(Typesetter { doc, mono, width: Mm::from(pw - 2.0 * margin), base_size })
    }

    pub fn mono_style(&self) -> Style {
        let mut style = Style::new();
        if let Some(mono) = self.mono {
            style.set_font_family(mono);
        }
        style
    }

    /// Builds a paragraph from styled runs, splitting any word wider than
    /// `max` so nothing is cut off at the right edge.
    pub fn paragraph(&self, runs: &[(String, Style)], max: Mm) -> Paragraph {
        let mut p = Paragraph::default();
        let cache = self.doc.font_cache();
        for (text, run_style) in runs {
            let style = Style::new().with_font_size(self.base_size).and(*run_style);
            let clean = clean(text);
            for word in clean.split_inclusive(' ') {
                if style.str_width(cache, word) <= max {
                    p.push(StyledString::new(word.to_string(), *run_style));
                    continue;
                }
                let mut chunk = String::new();
                for c in word.chars() {
                    chunk.push(c);
                    if style.str_width(cache, &chunk) > max * 0.98 {
                        let last = chunk.pop().unwrap_or_default();
                        if !chunk.is_empty() {
                            p.push(StyledString::new(std::mem::take(&mut chunk), *run_style));
                        }
                        chunk.push(last);
                    }
                }
                if !chunk.is_empty() {
                    p.push(StyledString::new(chunk, *run_style));
                }
            }
        }
        p
    }

    pub fn push<E: Element + 'static>(&mut self, element: E) {
        self.doc.push(element);
    }

    pub fn finish(self, output: &Path) -> Result<()> {
        let mut pdf = Vec::new();
        self.doc.render(&mut pdf).map_err(|e| anyhow::anyhow!("Could not lay out the PDF: {e}"))?;
        // Subsetting is an optimisation; keep the full PDF if it fails.
        let pdf = super::slim::slim(pdf.clone()).unwrap_or(pdf);
        std::fs::write(output, pdf).with_context(|| format!("Could not write {}", output.display()))
    }

    /// Lays out rows as a framed table. The first row is treated as the header.
    pub fn table(&mut self, rows: &[Vec<String>]) -> Result<()> {
        let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
        if cols == 0 {
            return Ok(());
        }
        // Weight columns by their longest cell (capped) so narrow columns stay narrow.
        let weights: Vec<usize> = (0..cols)
            .map(|c| rows.iter().take(200).map(|r| r.get(c).map_or(0, |s| s.chars().count())).max().unwrap_or(1).clamp(3, 40))
            .collect();
        let total: usize = weights.iter().sum();
        let mut table = TableLayout::new(weights.clone());
        table.set_cell_decorator(FrameCellDecorator::new(true, true, false));
        for (i, row) in rows.iter().enumerate() {
            let mut r = table.row();
            for (c, weight) in weights.iter().enumerate() {
                let cell_width = self.width * (*weight as f64 / total as f64) - Mm::from(2.2);
                let text = row.get(c).cloned().unwrap_or_default();
                let style = if i == 0 { Style::new().bold() } else { Style::new() };
                r.push_element(self.paragraph(&[(text, style)], cell_width.max(Mm::from(3))).padded(1));
            }
            r.push().map_err(|e| anyhow::anyhow!("Table layout failed: {e}"))?;
        }
        self.doc.push(table);
        Ok(())
    }
}

/// Removes characters fonts can't draw (control codes) and expands tabs.
pub fn clean(text: &str) -> String {
    text.replace('\t', "    ").replace('\u{a0}', " ").chars().filter(|c| !c.is_control()).collect()
}

fn read_text(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("Could not read {}", path.display()))?;
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    Ok(String::from_utf8_lossy(bytes).replace("\r\n", "\n").replace('\r', "\n"))
}

pub fn title_of(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).unwrap_or("document").to_string()
}

fn lines_to_paragraphs(ts: &mut Typesetter, text: &str, style: Style) {
    for line in text.lines() {
        if line.trim().is_empty() {
            ts.push(Break::new(1));
        } else {
            let p = ts.paragraph(&[(line.to_string(), style)], ts.width);
            ts.push(p);
        }
    }
}

/// Plain text and source code, set in monospace so alignment survives.
pub fn plain(input: &Path, output: &Path, options: &ConvertOptions) -> Result<()> {
    let text = read_text(input)?;
    let wide = text.lines().take(500).any(|l| l.chars().count() > 100);
    let mut ts = Typesetter::new(&title_of(input), options, wide, Fonts::Mono, 9)?;
    lines_to_paragraphs(&mut ts, &text, Style::new().with_color(INK));
    ts.finish(output)
}

/// HTML is reduced to readable text. LibreOffice, when present, keeps the layout instead.
pub fn html(input: &Path, output: &Path, options: &ConvertOptions) -> Result<()> {
    let source = std::fs::read(input).with_context(|| format!("Could not read {}", input.display()))?;
    let text = html2text::from_read(source.as_slice(), 100).context("This HTML file could not be read.")?;
    let mut ts = Typesetter::new(&title_of(input), options, false, Fonts::Sans, 10)?;
    lines_to_paragraphs(&mut ts, &text, Style::new().with_color(INK));
    ts.finish(output)
}

/// CSV and TSV become a table, on a landscape page when there are many columns.
pub fn delimited(input: &Path, output: &Path, options: &ConvertOptions, delimiter: u8) -> Result<()> {
    let text = read_text(input)?;
    let mut reader = csv::ReaderBuilder::new().delimiter(delimiter).has_headers(false).flexible(true).from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.context("This table file has a formatting error.")?;
        rows.push(record.iter().map(str::to_string).collect::<Vec<_>>());
    }
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut ts = Typesetter::new(&title_of(input), options, cols > 5, Fonts::Sans, if cols > 10 { 7 } else { 9 })?;
    if rows.is_empty() {
        ts.push(Paragraph::new(StyledString::new("This file has no rows.", Style::new().italic().with_color(MUTED))));
    } else {
        ts.table(&rows)?;
    }
    ts.finish(output)
}

/// Excel and OpenDocument spreadsheets: one table per sheet, each on a new page.
pub fn spreadsheet(input: &Path, output: &Path, options: &ConvertOptions) -> Result<()> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut workbook = open_workbook_auto(input).context("This spreadsheet could not be opened. Check that it is valid and not password-protected.")?;
    let names = workbook.sheet_names().to_vec();
    let mut sheets = Vec::new();
    for name in names {
        let Ok(range) = workbook.worksheet_range(&name) else { continue };
        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|row| {
                row.iter()
                    .map(|cell| match cell {
                        Data::Empty => String::new(),
                        Data::Float(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", *f as i64),
                        Data::DateTime(d) => d.as_datetime().map(|dt| dt.to_string()).unwrap_or_else(|| d.to_string()),
                        other => other.to_string(),
                    })
                    .collect()
            })
            .filter(|row: &Vec<String>| row.iter().any(|c| !c.is_empty()))
            .collect();
        sheets.push((name, rows));
    }
    let cols = sheets.iter().flat_map(|(_, rows)| rows.iter().map(Vec::len)).max().unwrap_or(0);
    let mut ts = Typesetter::new(&title_of(input), options, cols > 5, Fonts::Sans, if cols > 10 { 7 } else { 9 })?;
    for (i, (name, rows)) in sheets.iter().enumerate() {
        if i > 0 {
            ts.push(PageBreak::new());
        }
        ts.push(Paragraph::new(StyledString::new(name.clone(), Style::new().bold().with_font_size(14))).padded(genpdf::Margins::trbl(0, 0, 3, 0)));
        if rows.is_empty() {
            ts.push(Paragraph::new(StyledString::new("This sheet is empty.", Style::new().italic().with_color(MUTED))));
        } else {
            ts.table(rows)?;
        }
    }
    ts.finish(output)
}

/// Markdown with headings, emphasis, lists, quotes, code blocks and tables.
pub fn markdown(input: &Path, output: &Path, options: &ConvertOptions) -> Result<()> {
    use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
    let source = read_text(input)?;
    let mut ts = Typesetter::new(&title_of(input), options, false, Fonts::SansAndMono, 10)?;
    let mono = ts.mono_style();

    let mut runs: Vec<(String, Style)> = Vec::new();
    let mut bold = 0;
    let mut italic = 0;
    let mut heading: Option<u8> = None;
    let mut list_stack: Vec<Option<u64>> = Vec::new();
    let mut quote = 0usize;
    let mut code_block: Option<String> = None;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut cell = String::new();
    let mut link: Option<String> = None;

    let style_now = |bold: i32, italic: i32, heading: Option<u8>| {
        let mut s = Style::new().with_color(INK);
        if bold > 0 || heading.is_some() {
            s = s.bold();
        }
        if italic > 0 {
            s = s.italic();
        }
        if let Some(size) = heading {
            s = s.with_font_size(size);
        }
        s
    };

    fn flush(ts: &mut Typesetter, runs: &mut Vec<(String, Style)>, indent: f64, space_after: f64) {
        if runs.iter().all(|(t, _)| t.trim().is_empty()) {
            runs.clear();
            return;
        }
        let width = ts.width - Mm::from(indent);
        let p = ts.paragraph(runs, width);
        ts.push(p.padded(genpdf::Margins::trbl(0, 0, space_after, indent)));
        runs.clear();
    }

    let parser = Parser::new_ext(&source, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS);
    for event in parser {
        let indent = (list_stack.len() as f64) * 6.0 + quote as f64 * 6.0;
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut ts, &mut runs, indent, 2.0);
                heading = Some(match level {
                    HeadingLevel::H1 => 22,
                    HeadingLevel::H2 => 17,
                    HeadingLevel::H3 => 14,
                    HeadingLevel::H4 => 12,
                    _ => 11,
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut ts, &mut runs, indent, 3.0);
                heading = None;
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => flush(&mut ts, &mut runs, indent, 3.0),
            Event::Start(Tag::Strong) => bold += 1,
            Event::End(TagEnd::Strong) => bold -= 1,
            Event::Start(Tag::Emphasis) => italic += 1,
            Event::End(TagEnd::Emphasis) => italic -= 1,
            Event::Start(Tag::BlockQuote(_)) => {
                flush(&mut ts, &mut runs, indent, 2.0);
                quote += 1;
                italic += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush(&mut ts, &mut runs, indent, 3.0);
                quote = quote.saturating_sub(1);
                italic -= 1;
            }
            Event::Start(Tag::List(start)) => {
                flush(&mut ts, &mut runs, indent, 1.0);
                list_stack.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                flush(&mut ts, &mut runs, indent, 1.0);
                list_stack.pop();
                if list_stack.is_empty() {
                    ts.push(Break::new(0.5));
                }
            }
            Event::Start(Tag::Item) => {
                flush(&mut ts, &mut runs, indent, 1.0);
                let marker = match list_stack.last_mut() {
                    Some(Some(n)) => {
                        let m = format!("{n}. ");
                        *n += 1;
                        m
                    }
                    _ => "• ".to_string(),
                };
                runs.push((marker, Style::new().with_color(INK)));
            }
            Event::End(TagEnd::Item) => flush(&mut ts, &mut runs, indent, 1.0),
            Event::TaskListMarker(done) => runs.push((if done { "☑ " } else { "☐ " }.to_string(), Style::new())),
            Event::Start(Tag::CodeBlock(kind)) => {
                flush(&mut ts, &mut runs, indent, 2.0);
                let _ = matches!(kind, CodeBlockKind::Fenced(_));
                code_block = Some(String::new());
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(code) = code_block.take() {
                    let style = mono.with_font_size(8).with_color(INK);
                    let mut block = genpdf::elements::LinearLayout::vertical();
                    for line in code.trim_end_matches('\n').lines() {
                        if line.is_empty() {
                            block.push(Break::new(1));
                        } else {
                            block.push(ts.paragraph(&[(line.to_string(), style)], ts.width - Mm::from(indent + 6.0)));
                        }
                    }
                    ts.push(block.padded(genpdf::Margins::trbl(2, 2, 2, 2)).framed().padded(genpdf::Margins::trbl(0, 0, 3, indent)));
                }
            }
            Event::Start(Tag::Table(_)) => {
                flush(&mut ts, &mut runs, indent, 2.0);
                table = Some(Vec::new());
            }
            Event::End(TagEnd::Table) => {
                if let Some(rows) = table.take() {
                    ts.table(&rows)?;
                    ts.push(Break::new(1));
                }
            }
            Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => {
                if let Some(rows) = table.as_mut() {
                    rows.push(Vec::new());
                }
            }
            Event::Start(Tag::TableCell) => cell.clear(),
            Event::End(TagEnd::TableCell) => {
                if let Some(row) = table.as_mut().and_then(|rows| rows.last_mut()) {
                    row.push(std::mem::take(&mut cell));
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) => link = Some(dest_url.to_string()),
            Event::End(TagEnd::Link) => {
                if let Some(url) = link.take() {
                    if !url.is_empty() && !url.starts_with('#') && table.is_none() {
                        runs.push((format!(" ({url})"), Style::new().with_font_size(8).with_color(MUTED)));
                    }
                }
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                runs.push((format!("[image: {dest_url}] "), Style::new().italic().with_color(MUTED)));
            }
            Event::Text(text) => {
                if let Some(code) = code_block.as_mut() {
                    code.push_str(&text);
                } else if table.is_some() {
                    cell.push_str(&text);
                } else {
                    runs.push((text.to_string(), style_now(bold, italic, heading)));
                }
            }
            Event::Code(text) => {
                if table.is_some() {
                    cell.push_str(&text);
                } else {
                    runs.push((text.to_string(), mono.with_font_size(9).with_color(INK)));
                }
            }
            Event::SoftBreak => {
                if table.is_some() {
                    cell.push(' ');
                } else {
                    runs.push((" ".to_string(), Style::new()));
                }
            }
            Event::HardBreak => flush(&mut ts, &mut runs, indent, 0.0),
            Event::Rule => {
                flush(&mut ts, &mut runs, indent, 2.0);
                ts.push(Paragraph::new(StyledString::new("—".repeat(30), Style::new().with_color(MUTED))).aligned(Alignment::Center).padded(genpdf::Margins::trbl(1, 0, 3, 0)));
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                let text = html2text::from_read(html.as_bytes(), 200).unwrap_or_default();
                if !text.trim().is_empty() {
                    runs.push((text.trim().to_string(), style_now(bold, italic, heading)));
                }
            }
            _ => {}
        }
    }
    flush(&mut ts, &mut runs, 0.0, 0.0);
    ts.finish(output)
}
