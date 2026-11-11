//! Word (.docx) without LibreOffice: text, headings, emphasis, lists and tables.
//! Images and exact layout need LibreOffice; they appear as a placeholder here.

use super::text::{title_of, Fonts, Typesetter, INK, MUTED};
use super::ConvertOptions;
use anyhow::{Context, Result};
use genpdf::elements::{Break, PageBreak};
use genpdf::style::Style;
use genpdf::Element;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::io::Read;
use std::path::Path;

#[derive(Default)]
struct Para {
    runs: Vec<(String, Style)>,
    style: String,
    list: bool,
}

fn attr(e: &BytesStart, name: &str) -> Option<String> {
    e.attributes().flatten().find(|a| a.key.local_name().as_ref() == name).map(|a| a.value.to_string())
}

/// `<w:b/>` turns bold on; `<w:b w:val="0"/>` turns it off.
fn toggle_on(e: &BytesStart) -> bool {
    !matches!(attr(e, "val").as_deref(), Some("0" | "false" | "none"))
}

pub fn convert(input: &Path, output: &Path, options: &ConvertOptions) -> Result<()> {
    let file = std::fs::File::open(input).with_context(|| format!("Could not read {}", input.display()))?;
    let mut archive = zip::ZipArchive::new(file).context("This Word file is damaged or password-protected.")?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .context("This Word file has no document body.")?
        .take(200 * 1024 * 1024)
        .read_to_string(&mut xml)?;

    let mut ts = Typesetter::new(&title_of(input), options, false, Fonts::Sans, 10)?;
    let mut reader = Reader::from_str(&xml);
    let mut para: Option<Para> = None;
    let (mut bold, mut italic, mut in_text, mut in_rpr) = (false, false, false, false);
    // Stack of tables; each is a list of rows of cell text.
    let mut tables: Vec<Vec<Vec<String>>> = Vec::new();
    let mut cell: Option<String> = None;

    loop {
        let event = reader.read_event().context("This Word file's content could not be read.")?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                match e.local_name().as_ref() {
                    "p" if !empty => para = Some(Para::default()),
                    "r" if !empty => {
                        bold = false;
                        italic = false;
                    }
                    "rPr" if !empty => in_rpr = true,
                    "b" if in_rpr => bold = toggle_on(e),
                    "i" if in_rpr => italic = toggle_on(e),
                    "pStyle" => {
                        if let (Some(p), Some(v)) = (para.as_mut(), attr(e, "val")) {
                            p.style = v;
                        }
                    }
                    "numPr" => {
                        if let Some(p) = para.as_mut() {
                            p.list = true;
                        }
                    }
                    "t" if !empty => in_text = true,
                    "tab" if !in_rpr => push_text(&mut para, "    ", bold, italic),
                    "br" | "cr" => {
                        if attr(e, "type").as_deref() == Some("page") && tables.is_empty() {
                            flush(&mut ts, &mut para);
                            para = Some(Para::default());
                            ts.push(PageBreak::new());
                        } else if tables.is_empty() {
                            let style = para.as_ref().map(|p| p.style.clone()).unwrap_or_default();
                            flush(&mut ts, &mut para);
                            para = Some(Para { style, ..Default::default() });
                        } else {
                            push_text(&mut para, " ", bold, italic);
                        }
                    }
                    "drawing" | "pict" => {
                        if let Some(p) = para.as_mut() {
                            p.runs.push(("[image] ".into(), Style::new().italic().with_color(MUTED)));
                        }
                    }
                    "tbl" if !empty => {
                        if tables.is_empty() {
                            flush(&mut ts, &mut para);
                        }
                        tables.push(Vec::new());
                    }
                    "tr" if !empty => {
                        if let Some(t) = tables.last_mut() {
                            t.push(Vec::new());
                        }
                    }
                    "tc" if !empty && tables.len() == 1 => cell = Some(String::new()),
                    _ => {}
                }
            }
            Event::End(ref e) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "rPr" => in_rpr = false,
                "p" => {
                    if tables.is_empty() {
                        flush(&mut ts, &mut para);
                    } else if let (Some(c), Some(p)) = (cell.as_mut(), para.take()) {
                        let text: String = p.runs.iter().map(|(t, _)| t.as_str()).collect();
                        if !text.trim().is_empty() {
                            if !c.is_empty() {
                                c.push(' ');
                            }
                            c.push_str(text.trim());
                        }
                    }
                }
                "tc" if tables.len() == 1 => {
                    if let (Some(row), Some(c)) = (tables.last_mut().and_then(|t| t.last_mut()), cell.take()) {
                        row.push(c);
                    }
                }
                "tbl" => {
                    if let Some(rows) = tables.pop() {
                        if tables.is_empty() {
                            ts.table(&rows)?;
                            ts.push(Break::new(1));
                        } else if let Some(c) = cell.as_mut() {
                            // Nested tables are flattened into the outer cell.
                            for row in rows {
                                c.push(' ');
                                c.push_str(&row.join(" | "));
                            }
                        }
                    }
                }
                _ => {}
            },
            Event::Text(t) if in_text => push_text(&mut para, &t.xml10_content(), bold, italic),
            Event::GeneralRef(r) if in_text => {
                let resolved = match r.resolve_char_ref() {
                    Ok(Some(c)) => c.to_string(),
                    _ => match r.xml10_content().as_ref() {
                        "amp" => "&".into(),
                        "lt" => "<".into(),
                        "gt" => ">".into(),
                        "quot" => "\"".into(),
                        "apos" => "'".into(),
                        _ => String::new(),
                    },
                };
                push_text(&mut para, &resolved, bold, italic);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    flush(&mut ts, &mut para);
    ts.finish(output)
}

fn push_text(para: &mut Option<Para>, text: &str, bold: bool, italic: bool) {
    let Some(p) = para.as_mut() else { return };
    let mut style = Style::new().with_color(INK);
    if bold {
        style = style.bold();
    }
    if italic {
        style = style.italic();
    }
    p.runs.push((text.to_string(), style));
}

fn flush(ts: &mut Typesetter, para: &mut Option<Para>) {
    let Some(mut p) = para.take() else { return };
    if p.runs.iter().all(|(t, _)| t.trim().is_empty()) {
        ts.push(Break::new(1));
        return;
    }
    let style_name = p.style.to_ascii_lowercase();
    let heading_size = if style_name == "title" {
        Some(24)
    } else if let Some(level) = style_name.strip_prefix("heading").and_then(|n| n.parse::<u8>().ok()) {
        Some(match level {
            1 => 18,
            2 => 15,
            3 => 13,
            _ => 11,
        })
    } else {
        None
    };
    if let Some(size) = heading_size {
        for (_, style) in p.runs.iter_mut() {
            *style = style.bold().with_font_size(size);
        }
    }
    let indent = if p.list { 6.0 } else { 0.0 };
    if p.list {
        p.runs.insert(0, ("• ".into(), Style::new().with_color(INK)));
    }
    let width = ts.width - genpdf::Mm::from(indent);
    let paragraph = ts.paragraph(&p.runs, width);
    let after = if heading_size.is_some() { 3.0 } else if p.list { 1.0 } else { 2.5 };
    ts.push(paragraph.padded(genpdf::Margins::trbl(if heading_size.is_some() { 2.0 } else { 0.0 }, 0, after, indent)));
}
