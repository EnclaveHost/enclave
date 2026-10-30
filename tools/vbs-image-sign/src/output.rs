//! Complete public artifact directories become visible at the destination in
//! one Linux RENAME_NOREPLACE operation. A partial write never uses that name.
use enclave_vbs_image_sign::{hex, Result};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, OpenOptionsExt},
    },
    path::Path,
};

pub fn publish(out: &Path, files: &[(&str, &[u8])]) -> Result<()> {
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = out.file_name().ok_or("output must name a new directory")?;
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|_| "could not generate staging directory name")?;
    let mut staging_name = std::ffi::OsString::from(".");
    staging_name.push(name);
    staging_name.push(format!(".partial-{}", hex(&random)));
    let staging = parent.join(staging_name);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(|e| format!("create staging directory: {e}"))?;
    for (name, bytes) in files {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(staging.join(name))
            .map_err(|e| format!("create staged {name}: {e}; output was not published"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("write staged {name}: {e}; output was not published"))?;
    }
    File::open(&staging)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync staging directory: {e}"))?;
    let from = CString::new(staging.as_os_str().as_bytes()).map_err(|_| "NUL in staging path")?;
    let to = CString::new(out.as_os_str().as_bytes()).map_err(|_| "NUL in output path")?;
    // SAFETY: both arguments are live NUL-terminated paths. NOREPLACE is
    // mandatory; unsupported kernels/filesystems fail without a fallback.
    let rc = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc != 0 {
        return Err(format!(
            "publish without replacement: {}; staging retained",
            std::io::Error::last_os_error()
        ));
    }
    File::open(parent).and_then(|f| f.sync_all()).map_err(|e| {
        format!("complete output exists but parent durability could not be confirmed: {e}")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let mut bytes = [0; 16];
            getrandom::getrandom(&mut bytes).unwrap();
            let path = std::env::temp_dir().join(format!("vbs-publish-test-{}", hex(&bytes)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn publishes_complete_directory_and_syncs_files_with_private_permissions() {
        let root = Scratch::new();
        let out = root.0.join("release");
        publish(
            &out,
            &[("image.igvm", b"image"), ("manifest.json", b"manifest")],
        )
        .unwrap();
        assert_eq!(fs::read(out.join("image.igvm")).unwrap(), b"image");
        assert_eq!(fs::read(out.join("manifest.json")).unwrap(), b"manifest");
        assert_eq!(
            fs::metadata(&out).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(out.join("image.igvm"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
    }
    #[test]
    fn rename_refuses_existing_empty_directory_file_and_symlink() {
        let root = Scratch::new();
        for kind in 0..3 {
            let out = root.0.join(format!("existing-{kind}"));
            match kind {
                0 => fs::create_dir(&out).unwrap(),
                1 => fs::write(&out, b"keep").unwrap(),
                _ => symlink("never-follow-this", &out).unwrap(),
            }
            let error = publish(&out, &[("image.igvm", b"image")]).unwrap_err();
            assert!(error.contains("publish without replacement"), "{error}");
            match kind {
                0 => assert_eq!(fs::read_dir(&out).unwrap().count(), 0),
                1 => assert_eq!(fs::read(&out).unwrap(), b"keep"),
                _ => assert_eq!(fs::read_link(&out).unwrap(), Path::new("never-follow-this")),
            }
        }
    }
    #[test]
    fn partial_write_is_never_visible_as_final_output() {
        let root = Scratch::new();
        let out = root.0.join("release");
        let error = publish(
            &out,
            &[
                ("image.igvm", b"image"),
                ("missing/manifest.json", b"manifest"),
            ],
        )
        .unwrap_err();
        assert!(error.contains("output was not published"));
        assert!(!out.exists());
        let staging = fs::read_dir(&root.0)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(staging.join("image.igvm")).unwrap(), b"image");
        assert!(!staging.join("manifest.json").exists());
    }
}
