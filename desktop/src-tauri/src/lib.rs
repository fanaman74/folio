mod convert;

use convert::{ConvertOptions, ConvertOutcome, EngineStatus};
use std::path::PathBuf;

/// Reports which conversion engines this computer has, so the UI can show
/// which formats are available before the user adds any files.
#[tauri::command]
fn engine_status() -> EngineStatus {
    convert::engine_status()
}

/// Converts one file to PDF and returns where the PDF was written.
/// Work runs on a blocking thread so the window stays responsive.
#[tauri::command]
async fn convert_file(path: String, options: ConvertOptions) -> Result<ConvertOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || convert::convert_file(PathBuf::from(path), &options))
        .await
        .map_err(|_| "The conversion stopped unexpectedly.".to_string())?
        .map_err(|error| format!("{error:#}"))
}

/// Expands dropped or picked paths: folders become the files inside them
/// (up to four levels deep, hidden files skipped, at most 500 files).
#[tauri::command]
fn expand_paths(paths: Vec<String>) -> Vec<String> {
    fn walk(path: &std::path::Path, depth: usize, out: &mut Vec<String>) {
        if out.len() >= 500 {
            return;
        }
        let hidden = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.'));
        if path.is_file() {
            out.push(path.to_string_lossy().into_owned());
        } else if path.is_dir() && depth < 4 && !(hidden && depth > 0) {
            let Ok(entries) = std::fs::read_dir(path) else { return };
            let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            children.sort();
            for child in children {
                if !child.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.')) {
                    walk(&child, depth + 1, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    for path in paths {
        walk(std::path::Path::new(&path), 0, &mut out);
    }
    out
}

/// Combines finished PDFs, in order, into one document.
#[tauri::command]
async fn merge_pdfs(paths: Vec<String>, output: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let inputs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        convert::merge::merge(&inputs, &PathBuf::from(&output)).map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "Combining stopped unexpectedly.".to_string())?
    .map_err(|error| format!("{error:#}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![engine_status, expand_paths, convert_file, merge_pdfs])
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
