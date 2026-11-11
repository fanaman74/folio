//! Joins PDFs, in the given order, into one document.

use anyhow::{bail, Context, Result};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId};
use std::path::{Path, PathBuf};

/// Page attributes a page may inherit from its parent page tree nodes.
const INHERITED: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

pub fn merge(inputs: &[PathBuf], output: &Path) -> Result<PathBuf> {
    if inputs.len() < 2 {
        bail!("Choose at least two PDFs to combine.");
    }
    let mut merged = Document::with_version("1.7");
    let mut next_id = 1;
    let mut pages: Vec<(ObjectId, Dictionary)> = Vec::new();

    for path in inputs {
        let mut doc = Document::load(path).with_context(|| format!("Could not read {}", path.display()))?;
        if doc.is_encrypted() {
            bail!("{} is password-protected and can't be combined.", path.display());
        }
        doc.renumber_objects_with(next_id);
        next_id = doc.max_id + 1;

        let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
        for id in &page_ids {
            let mut page = doc.get_dictionary(*id).context("A page could not be read.")?.clone();
            // Copy inherited attributes down so each page stands alone.
            let mut parent = page.get(b"Parent").and_then(Object::as_reference).ok();
            while let Some(pid) = parent {
                let Ok(node) = doc.get_dictionary(pid) else { break };
                for key in INHERITED {
                    if !page.has(key) {
                        if let Ok(value) = node.get(key) {
                            page.set(key, value.clone());
                        }
                    }
                }
                parent = node.get(b"Parent").and_then(Object::as_reference).ok();
            }
            pages.push((*id, page));
        }

        for (id, object) in doc.objects {
            let kind = object.type_name().unwrap_or(b"");
            if matches!(kind, b"Catalog" | b"Pages" | b"Page" | b"Outlines" | b"Outline") || page_ids.contains(&id) {
                continue;
            }
            merged.objects.insert(id, object);
        }
    }

    merged.max_id = next_id;
    let pages_id = merged.new_object_id();
    for (id, mut page) in pages.iter().cloned() {
        page.set("Parent", pages_id);
        merged.objects.insert(id, Object::Dictionary(page));
    }
    merged.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Count" => pages.len() as i64,
            "Kids" => pages.iter().map(|(id, _)| Object::Reference(*id)).collect::<Vec<_>>(),
        }),
    );
    let catalog_id = merged.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    merged.trailer.set("Root", catalog_id);
    merged.renumber_objects();
    merged.compress();

    let mut target = output.to_path_buf();
    if target.extension().is_none_or(|e| !e.eq_ignore_ascii_case("pdf")) {
        target.set_extension("pdf");
    }
    let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("Combined").to_string();
    let mut n = 2;
    while target.exists() {
        target.set_file_name(format!("{stem} ({n}).pdf"));
        n += 1;
    }
    merged.save(&target).with_context(|| format!("Could not write {}", target.display()))?;
    Ok(target)
}
