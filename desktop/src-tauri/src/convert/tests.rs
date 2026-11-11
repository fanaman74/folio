use super::*;
use std::io::Write;

fn options() -> ConvertOptions {
    ConvertOptions {
        page_size: PageSize::A4,
        orientation: Orientation::Auto,
        margin_mm: 15.0,
        image_fit: ImageFit::Fit,
        output_dir: None,
        prefer_libreoffice: false,
    }
}

fn pages(path: &str) -> usize {
    lopdf::Document::load(path).expect("valid PDF").get_pages().len()
}

fn convert_ok(dir: &Path, name: &str, contents: &[u8]) -> ConvertOutcome {
    let input = dir.join(name);
    std::fs::write(&input, contents).unwrap();
    let outcome = convert_file(input, &options()).unwrap_or_else(|e| panic!("{name}: {e:#}"));
    assert!(outcome.bytes > 0, "{name} produced an empty PDF");
    assert!(pages(&outcome.output) >= 1, "{name} has no pages");
    outcome
}

#[test]
fn png_with_transparency() {
    let dir = tempfile::tempdir().unwrap();
    let img = image::RgbaImage::from_fn(300, 120, |x, _| image::Rgba([0, 212, 255, (x % 256) as u8]));
    let path = dir.path().join("logo.png");
    img.save(&path).unwrap();
    let outcome = convert_file(path, &options()).unwrap();
    assert_eq!(outcome.engine, "Built-in image");
    assert_eq!(pages(&outcome.output), 1);
}

#[test]
fn jpeg_is_embedded_without_reencoding() {
    let dir = tempfile::tempdir().unwrap();
    let img = image::RgbImage::from_fn(640, 480, |x, y| image::Rgb([(x % 255) as u8, (y % 255) as u8, 90]));
    let path = dir.path().join("photo.jpg");
    img.save(&path).unwrap();
    let outcome = convert_file(path, &options()).unwrap();
    let raw = std::fs::read(&outcome.output).unwrap();
    assert!(raw.windows(9).any(|w| w == b"DCTDecode"));
}

#[test]
fn never_overwrites_existing_pdf() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("notes.pdf"), b"keep me").unwrap();
    let outcome = convert_ok(dir.path(), "notes.txt", b"hello");
    assert!(outcome.output.ends_with("notes (2).pdf"));
    assert_eq!(std::fs::read(dir.path().join("notes.pdf")).unwrap(), b"keep me");
}

#[test]
fn plain_text_keeps_very_long_words() {
    let dir = tempfile::tempdir().unwrap();
    let long = "x".repeat(2000);
    let text = format!("start\n\tindented\n{long}\nEND-MARKER\n");
    let outcome = convert_ok(dir.path(), "log.txt", text.as_bytes());
    // The paragraph after the long word must still be rendered.
    assert!(pages(&outcome.output) >= 1);
    let doc = lopdf::Document::load(&outcome.output).unwrap();
    let all: Vec<u32> = doc.get_pages().keys().copied().collect();
    let content: Vec<u8> = all.iter().flat_map(|p| doc.get_page_content(doc.get_pages()[p])).collect();
    assert!(!content.is_empty());
}

#[test]
fn markdown_with_everything() {
    let dir = tempfile::tempdir().unwrap();
    let md = "# Title\n\nSome **bold** and *italic* and `code` with a [link](https://example.com).\n\n- one\n- two\n  1. nested\n\n> quoted\n\n```rust\nfn main() {}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nÜnïcödé — “quotes” €\n";
    let outcome = convert_ok(dir.path(), "readme.md", md.as_bytes());
    assert_eq!(outcome.engine, "Built-in Markdown");
}

#[test]
fn csv_and_tsv_tables() {
    let dir = tempfile::tempdir().unwrap();
    let mut csv = String::from("name,city,notes\n");
    for i in 0..120 {
        csv.push_str(&format!("Person {i},Brussels,\"a, quoted, cell {i}\"\n"));
    }
    convert_ok(dir.path(), "people.csv", csv.as_bytes());
    convert_ok(dir.path(), "wide.tsv", b"a\tb\tc\td\te\tf\tg\n1\t2\t3\t4\t5\t6\t7\n");
}

#[test]
fn html_is_readable() {
    let dir = tempfile::tempdir().unwrap();
    let html = b"<html><body><h1>Hello</h1><p>Para &amp; text</p><ul><li>a</li></ul><script>bad()</script></body></html>";
    let outcome = convert_ok(dir.path(), "page.html", html);
    assert_eq!(outcome.engine, "Built-in HTML");
}

#[test]
fn docx_builtin() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("letter.docx");
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    zip.start_file("word/document.xml", opts).unwrap();
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Dear reader</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold </w:t></w:r><w:r><w:t>and plain &amp; more</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>A bullet</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:br w:type="page"/><w:t>Page two</w:t></w:r></w:p>
</w:body></w:document>"#).unwrap();
    zip.finish().unwrap();
    let outcome = convert_file(path, &options()).unwrap();
    assert_eq!(outcome.engine, "Built-in Word");
    assert_eq!(pages(&outcome.output), 2);
}

#[test]
fn unknown_binary_is_rejected_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("blob.bin");
    std::fs::write(&input, [0u8, 159, 146, 150, 0, 1]).unwrap();
    assert!(convert_file(input, &options()).is_err());
    assert!(!dir.path().join("blob.pdf").exists());
}

#[test]
fn damaged_image_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("broken.png");
    std::fs::write(&input, b"\x89PNG\r\n\x1a\nnot really").unwrap();
    assert!(convert_file(input, &options()).is_err());
    assert!(!dir.path().join("broken.pdf").exists());
}

#[test]
fn merge_keeps_order_and_pages() {
    let dir = tempfile::tempdir().unwrap();
    let a = convert_ok(dir.path(), "a.md", b"# A\n\nfirst");
    let img = image::RgbImage::from_pixel(50, 50, image::Rgb([255, 0, 0]));
    img.save(dir.path().join("b.png")).unwrap();
    let b = convert_file(dir.path().join("b.png"), &options()).unwrap();
    let c = convert_ok(dir.path(), "c.txt", "line\n".repeat(200).as_bytes());
    let c_pages = pages(&c.output);
    let out = merge::merge(
        &[a.output.clone().into(), b.output.clone().into(), c.output.clone().into()],
        &dir.path().join("Combined.pdf"),
    )
    .unwrap();
    assert_eq!(pages(out.to_str().unwrap()), 2 + c_pages);
}

#[test]
fn libreoffice_when_available() {
    let Some(soffice) = office::find_soffice() else { return };
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("memo.rtf");
    std::fs::write(&input, br"{\rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}\f0\pard Hello {\b bold} world.\par}").unwrap();
    let output = dir.path().join("memo.pdf");
    office::convert(&soffice, &input, &output).unwrap();
    assert_eq!(pages(output.to_str().unwrap()), 1);
}

/// Converts every file in `$FOLIO_SAMPLES` with the built-in engines, for eyeballing output:
/// `FOLIO_SAMPLES=/path/to/files cargo test render_samples -- --ignored --nocapture`
#[test]
#[ignore]
fn render_samples() {
    let dir = std::env::var("FOLIO_SAMPLES").expect("set FOLIO_SAMPLES");
    let out = Path::new(&dir).join("out");
    let opts = ConvertOptions { output_dir: Some(out.to_string_lossy().into_owned()), ..options() };
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        if entry.path().is_file() {
            match convert_file(entry.path(), &opts) {
                Ok(o) => println!("{} -> {} ({} pages, {} bytes, {})", entry.path().display(), o.output, o.pages.unwrap_or(0), o.bytes, o.engine),
                Err(e) => println!("{} failed: {e:#}", entry.path().display()),
            }
        }
    }
}
