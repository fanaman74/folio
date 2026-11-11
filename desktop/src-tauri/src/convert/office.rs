//! Office documents through a locally installed LibreOffice.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(240);

/// Finds `soffice` on PATH or in LibreOffice's default install locations.
pub fn find_soffice() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("FOLIO_SOFFICE").map(PathBuf::from) {
        if configured.is_file() {
            return Some(configured);
        }
    }
    let names: &[&str] = if cfg!(windows) { &["soffice.exe", "soffice.com"] } else { &["soffice", "libreoffice"] };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    let fixed: &[&str] = if cfg!(target_os = "macos") {
        &["/Applications/LibreOffice.app/Contents/MacOS/soffice", "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice"]
    } else if cfg!(windows) {
        &[r"C:\Program Files\LibreOffice\program\soffice.exe", r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"]
    } else {
        &["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice", "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice"]
    };
    fixed.iter().map(PathBuf::from).find(|p| p.is_file())
}

pub fn convert(soffice: &Path, input: &Path, output: &Path) -> Result<()> {
    // Each run gets its own scratch folder and LibreOffice profile, so it never
    // collides with a LibreOffice window the user already has open.
    let work = std::env::temp_dir().join(format!("folio-{}-{}", std::process::id(), unique()));
    let out_dir = work.join("out");
    let profile = work.join("profile");
    std::fs::create_dir_all(profile.join("user"))?;
    std::fs::create_dir_all(&out_dir)?;
    // Disable macros and automatic link updates in the throwaway profile.
    std::fs::write(
        profile.join("user").join("registrymodifications.xcu"),
        r#"<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>"#,
    )?;
    let result = run(soffice, input, &out_dir, &profile).and_then(|_| {
        let produced = std::fs::read_dir(&out_dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")))
            .context("LibreOffice could not convert this file. Check that it is valid and not password-protected.")?;
        if std::fs::rename(&produced, output).is_err() {
            std::fs::copy(&produced, output).with_context(|| format!("Could not write {}", output.display()))?;
        }
        Ok(())
    });
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn run(soffice: &Path, input: &Path, out_dir: &Path, profile: &Path) -> Result<()> {
    let profile_url = url::Url::from_directory_path(profile).map_err(|_| anyhow::anyhow!("Invalid temporary folder."))?;
    let mut command = Command::new(soffice);
    command
        .arg(format!("-env:UserInstallation={profile_url}"))
        .args(["--headless", "--norestore", "--nodefault", "--nofirststartwizard", "--nolockcheck", "--convert-to", "pdf", "--outdir"])
        .arg(out_dir)
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().context("LibreOffice could not be started.")?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                bail!("LibreOffice could not convert this file. Check that it is valid and not password-protected.");
            }
            return Ok(());
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            bail!("LibreOffice took longer than four minutes and was stopped. Try a smaller file.");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn unique() -> u128 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    nanos ^ COUNTER.fetch_add(1, Ordering::Relaxed) as u128
}
