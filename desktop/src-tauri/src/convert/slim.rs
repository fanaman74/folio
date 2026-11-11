//! Shrinks typeset PDFs. The PDF writer embeds every bundled font in full
//! (about 400 KB each); this keeps only the glyphs the pages actually draw and
//! compresses every stream, taking a one-page document from ~2 MB to ~40 KB.

use anyhow::Result;
use lopdf::{Document, Object, ObjectId};
use std::collections::{BTreeMap, BTreeSet};

pub fn slim(pdf: Vec<u8>) -> Result<Vec<u8>> {
    let mut doc = Document::load_mem(&pdf)?;
    // Glyph ids used, keyed by the FontFile2 stream that holds the font program.
    let mut used: BTreeMap<ObjectId, BTreeSet<u16>> = BTreeMap::new();

    for page_id in doc.get_pages().into_values() {
        let fonts: BTreeMap<Vec<u8>, ObjectId> = doc
            .get_page_fonts(page_id)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(name, font)| font_file(&doc, font).map(|id| (name, id)))
            .collect();
        let Ok(content) = doc.get_and_decode_page_content(page_id) else { continue };
        let mut current: Option<ObjectId> = None;
        for op in content.operations {
            match op.operator.as_str() {
                "Tf" => current = op.operands.first().and_then(|n| n.as_name().ok()).and_then(|n| fonts.get(n).copied()),
                "Tj" | "'" | "\"" | "TJ" => {
                    let Some(file) = current else { continue };
                    let set = used.entry(file).or_default();
                    for operand in &op.operands {
                        collect_glyphs(operand, set);
                    }
                }
                _ => {}
            }
        }
    }

    // Every embedded TrueType program: subset the used ones, empty the rest.
    let files: Vec<ObjectId> = doc
        .objects
        .values()
        .filter_map(|o| o.as_dict().ok())
        .filter_map(|d| d.get(b"FontFile2").and_then(Object::as_reference).ok())
        .collect();
    for id in files {
        let mut glyphs: Vec<u16> = used.get(&id).map(|s| s.iter().copied().collect()).unwrap_or_default();
        glyphs.push(0);
        if let Ok(Object::Stream(stream)) = doc.get_object_mut(id) {
            let data = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
            if let Ok(subset) = subsetter::subset(&data, 0, subsetter::Profile::pdf(&glyphs)) {
                stream.dict.remove(b"Filter");
                stream.dict.set("Length1", subset.len() as i64);
                stream.set_content(subset);
            }
        }
    }

    trim_font_tables(&mut doc, &used);
    doc.compress();
    let mut out = Vec::new();
    doc.save_to(&mut out)?;
    Ok(out)
}

/// Follows Type0 font -> DescendantFonts -> FontDescriptor -> FontFile2.
fn font_file(doc: &Document, font: &lopdf::Dictionary) -> Option<ObjectId> {
    let descendants = font.get(b"DescendantFonts").ok()?;
    let descendants = match descendants {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    let first = descendants.as_array().ok()?.first()?;
    let cid_font = match first {
        Object::Reference(id) => doc.get_dictionary(*id).ok()?,
        Object::Dictionary(d) => d,
        _ => return None,
    };
    let descriptor = match cid_font.get(b"FontDescriptor").ok()? {
        Object::Reference(id) => doc.get_dictionary(*id).ok()?,
        Object::Dictionary(d) => d,
        _ => return None,
    };
    descriptor.get(b"FontFile2").and_then(Object::as_reference).ok()
}

/// Text in Identity-H fonts is a string of big-endian 16-bit glyph ids.
fn collect_glyphs(operand: &Object, set: &mut BTreeSet<u16>) {
    match operand {
        Object::String(bytes, _) => {
            for pair in bytes.chunks_exact(2) {
                set.insert(u16::from_be_bytes([pair[0], pair[1]]));
            }
        }
        Object::Array(items) => items.iter().for_each(|item| collect_glyphs(item, set)),
        _ => {}
    }
}

/// The writer also lists a width and a Unicode mapping for every glyph in each
/// font. Keep only the entries for glyphs that are drawn.
fn trim_font_tables(doc: &mut Document, used: &BTreeMap<ObjectId, BTreeSet<u16>>) {
    let empty = BTreeSet::new();
    let type0: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter(|(_, o)| o.as_dict().is_ok_and(|d| d.get(b"Subtype").and_then(Object::as_name).is_ok_and(|n| n == b"Type0")))
        .map(|(id, _)| *id)
        .collect();
    for font_id in type0 {
        let Ok(font) = doc.get_dictionary(font_id) else { continue };
        let glyphs = font_file(doc, font).and_then(|f| used.get(&f)).unwrap_or(&empty).clone();
        let to_unicode = font.get(b"ToUnicode").and_then(Object::as_reference).ok();
        let descendant = font.get(b"DescendantFonts").ok().and_then(|d| match d {
            Object::Array(items) => items.first().and_then(|i| i.as_reference().ok()),
            Object::Reference(id) => doc.get_object(*id).ok().and_then(|a| a.as_array().ok()).and_then(|a| a.first()).and_then(|i| i.as_reference().ok()),
            _ => None,
        });

        // Widths: [first [w w w] first [w w] ...] -> only used glyphs.
        let trim_widths = |w: &Object| -> Option<Object> {
            let items = w.as_array().ok()?;
            let mut widths = BTreeMap::new();
            let mut i = 0;
            while i + 1 < items.len() {
                let (Ok(start), Ok(list)) = (items[i].as_i64(), items[i + 1].as_array()) else { return None };
                for (k, width) in list.iter().enumerate() {
                    let gid = start + k as i64;
                    if gid >= 0 && gid <= u16::MAX as i64 && glyphs.contains(&(gid as u16)) {
                        widths.insert(gid, width.clone());
                    }
                }
                i += 2;
            }
            Some(Object::Array(widths.into_iter().flat_map(|(gid, w)| [Object::Integer(gid), Object::Array(vec![w])]).collect()))
        };
        if let Some(id) = descendant {
            if let Ok(Object::Dictionary(cid)) = doc.get_object_mut(id) {
                if let Some(w) = cid.get(b"W").ok().and_then(trim_widths) {
                    cid.set("W", w);
                }
            }
        } else if let Ok(Object::Dictionary(font)) = doc.get_object_mut(font_id) {
            if let Ok(Object::Array(items)) = font.get_mut(b"DescendantFonts") {
                if let Some(Object::Dictionary(cid)) = items.first_mut() {
                    if let Some(w) = cid.get(b"W").ok().and_then(trim_widths) {
                        cid.set("W", w);
                    }
                }
            }
        }

        // ToUnicode CMap: rebuild its bfchar blocks with only used glyphs.
        if let Some(id) = to_unicode {
            if let Ok(Object::Stream(stream)) = doc.get_object_mut(id) {
                let Ok(raw) = stream.decompressed_content().or_else(|_| Ok::<_, lopdf::Error>(stream.content.clone())) else { continue };
                let text = String::from_utf8_lossy(&raw).into_owned();
                let (Some(first), Some(last)) = (text.find("beginbfchar"), text.rfind("endbfchar")) else { continue };
                let head_end = text[..first].rfind('\n').map_or(0, |i| i + 1);
                let tail_start = last + "endbfchar".len();
                let mut kept = Vec::new();
                for line in text[head_end..tail_start].lines() {
                    let line = line.trim();
                    if let Some(rest) = line.strip_prefix('<') {
                        if let Some(gid_hex) = rest.split('>').next() {
                            if u16::from_str_radix(gid_hex, 16).is_ok_and(|g| glyphs.contains(&g)) {
                                kept.push(line.to_string());
                            }
                        }
                    }
                }
                let mut cmap = text[..head_end].to_string();
                for block in kept.chunks(100) {
                    cmap.push_str(&format!("{} beginbfchar\n{}\nendbfchar\n", block.len(), block.join("\n")));
                }
                cmap.push_str(text[tail_start..].trim_start_matches(['\r', '\n']));
                stream.dict.remove(b"Filter");
                stream.set_content(cmap.into_bytes());
            }
        }
    }
}
