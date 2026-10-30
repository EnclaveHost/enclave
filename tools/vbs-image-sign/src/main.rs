#[cfg(not(target_os = "linux"))]
compile_error!(
    "The release signer currently requires Linux atomic directory publication semantics"
);
mod output;
use enclave_vbs_image_sign::{
    hash, hex, hex32, public_blob, Identity, Image, Result, MAX_IMAGE_BYTES,
};
use p384::{ecdsa::SigningKey, pkcs8::DecodePrivateKey};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env,
    fs::OpenOptions,
    io::{IsTerminal, Read},
};
use zeroize::Zeroizing;

const USAGE: &str = "enclave-vbs-image-sign inspect --input IMAGE\n\
enclave-vbs-image-sign sign --input IMAGE --expected-input-sha256 HEX --expected-signer HEX --product-id U32 --module-id U32 --svn U32 --output NEW_DIRECTORY < release-key.pkcs8.pem\n\
enclave-vbs-image-sign verify --input IMAGE --expected-input-sha256 HEX --expected-measurement HEX --expected-signer HEX --product-id U32 --module-id U32 --minimum-svn U32\n\
Only canonical IGVM V1, one VSM platform (mask 1, VTL 2), zero debug policy. Native SVN floor: 13.\n\
Signing reads a bounded unencrypted P384 PKCS8 PEM from stdin, never argv, environment or an automatically selected key.\n\
Verify checks local artifact/signature pins; it does not attest a VM, authorize an owner or admit a deployment.";
fn take(args: &mut BTreeMap<String, String>, name: &str) -> Result<String> {
    args.remove(name).ok_or_else(|| format!("missing {name}"))
}
fn number(args: &mut BTreeMap<String, String>, name: &str) -> Result<u32> {
    let s = take(args, name)?;
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{name} must be an unsigned decimal u32"));
    }
    s.parse().map_err(|_| format!("{name} is outside u32"))
}
fn digest(args: &mut BTreeMap<String, String>, name: &str) -> Result<String> {
    let s = take(args, name)?;
    hex32(&s).map_err(|_| format!("{name} requires 64 lowercase hex characters"))?;
    Ok(s)
}
fn read_image(path: &str) -> Result<Vec<u8>> {
    use std::os::unix::fs::OpenOptionsExt;
    // O_NONBLOCK avoids waiting forever if an input path is a FIFO; fstat on
    // the opened descriptor then rejects anything other than a regular file.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("open image: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("image metadata: {e}"))?;
    if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err("image must be a regular file of at most 256 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read image: {e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image exceeds 256 MiB".into());
    }
    Ok(bytes)
}
fn identity_json(identity: Option<&Identity>) -> Value {
    match identity {
        Some(i) => {
            json!({"signer":i.signer,"productId":i.product_id,"moduleId":i.module_id})
        }
        None => Value::Null,
    }
}
fn run() -> Result<()> {
    let mut input = env::args().skip(1);
    let mode = input.next().ok_or(USAGE)?;
    if mode == "--help" {
        println!("{USAGE}");
        return Ok(());
    }
    if !["inspect", "sign", "verify"].contains(&mode.as_str()) {
        return Err("unknown command (use --help)".into());
    }
    let mut args = BTreeMap::new();
    while let Some(k) = input.next() {
        if !k.starts_with("--") {
            return Err("expected a named option".into());
        }
        let v = input
            .next()
            .ok_or_else(|| format!("missing value for {k}"))?;
        if args.insert(k.clone(), v).is_some() {
            return Err(format!("duplicate option {k}"));
        }
    }
    let input_path = take(&mut args, "--input")?;
    let mut input_pin = None;
    let mut measurement_pin = None;
    let mut signer_pin = None;
    let mut product = 0;
    let mut module = 0;
    let mut svn = 0;
    let mut output = None;
    if mode != "inspect" {
        input_pin = Some(digest(&mut args, "--expected-input-sha256")?);
        signer_pin = Some(digest(&mut args, "--expected-signer")?);
        if signer_pin.as_deref() == Some(&"0".repeat(64)) {
            return Err("zero signer is not a release authority".into());
        }
        product = number(&mut args, "--product-id")?;
        module = number(&mut args, "--module-id")?;
        svn = number(
            &mut args,
            if mode == "sign" {
                "--svn"
            } else {
                "--minimum-svn"
            },
        )?;
        if svn < 13 {
            return Err("native signing profile requires an SVN floor of at least 13".into());
        }
        if mode == "sign" {
            output = Some(take(&mut args, "--output")?);
        } else {
            measurement_pin = Some(digest(&mut args, "--expected-measurement")?);
        }
    }
    if !args.is_empty() {
        return Err(format!(
            "unknown options: {}",
            args.keys().cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    let bytes = read_image(&input_path)?;
    let input_hash = hash(&bytes);
    if input_pin.as_ref().is_some_and(|p| *p != input_hash) {
        return Err("input SHA256 does not match the independently pinned artifact".into());
    }
    let image = Image::parse(&bytes)?;
    let existing = image.identity()?;
    if mode == "inspect" {
        println!(
            "{}",
            json!({"imageSha256":input_hash,"bytes":bytes.len(),"launchMeasurement":hex(&image.digest),
            "identity":identity_json(existing.as_ref()),"guestSvn":existing.as_ref().map(|i|i.svn),"signatureVerified":existing.is_some(),"releaseAuthorityVerified":false,"hardwareAttestation":false})
        );
        return Ok(());
    }
    if mode == "verify" {
        let id = existing.ok_or("image is unsigned")?;
        if Some(&id.signer) != signer_pin.as_ref()
            || id.product_id != product
            || id.module_id != module
            || id.svn < svn
            || measurement_pin.as_deref() != Some(&hex(&image.digest))
        {
            return Err(
                "image does not satisfy the supplied release identity, measurement and SVN pins"
                    .into(),
            );
        }
        println!(
            "{}",
            json!({"verified":true,"imageSha256":input_hash,"launchMeasurement":hex(&image.digest),
            "identity":identity_json(Some(&id)),"guestSvn":id.svn,"hardwareAttestation":false,"productionAdmission":false})
        );
        return Ok(());
    }
    if existing.is_some() {
        return Err("refusing to sign an already signed image".into());
    }
    let out = std::path::PathBuf::from(output.ok_or("missing output")?);
    if out.symlink_metadata().is_ok() {
        return Err("output directory already exists; nothing overwritten".into());
    }
    if std::io::stdin().is_terminal() {
        return Err(
            "refusing interactive key input; provide PKCS8 PEM on a pipe or redirected descriptor"
                .into(),
        );
    }
    let mut key_bytes = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take(16385)
        .read_to_end(&mut key_bytes)
        .map_err(|_| "could not read signing key from stdin")?;
    if key_bytes.len() > 16384 {
        return Err("signing key input exceeds 16 KiB".into());
    }
    let key_text = std::str::from_utf8(&key_bytes)
        .map_err(|_| "signing key must be unencrypted P384 PKCS8 PEM")?;
    let key = SigningKey::from_pkcs8_pem(key_text)
        .map_err(|_| "signing key must be unencrypted P384 PKCS8 PEM")?;
    let pubkey = public_blob(key.verifying_key());
    if Some(&hash(&pubkey)) != signer_pin.as_ref() {
        return Err("signing key does not match the independently pinned signer".into());
    }
    let signed = image.sign(&key, product, module, svn)?;
    drop(key);
    drop(key_bytes);
    let identity = Image::parse(&signed)?
        .identity()?
        .ok_or("output identity missing")?;
    let manifest = json!({"schema":"enclave-vbs-signed-image/1","toolVersion":env!("CARGO_PKG_VERSION"),
        "profile":"igvm-v1-vsm-mask1-vtl2-p384-sha384/1","unsignedImageSha256":input_hash,
        "signedImageSha256":hash(&signed),"signedImageBytes":signed.len(),"launchMeasurement":hex(&image.digest),
        "identity":identity_json(Some(&identity)),"guestSvn":identity.svn,"publicKeyFile":"public-cng.bin","imageFile":"image.igvm",
        "signatureVerified":true,"originalParsedObjectsPreserved":true,"launchMeasurementPreserved":true,
        "hardwareAttestation":false,"productionAdmission":false});
    let mut manifest_bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| "manifest serialization failed")?;
    manifest_bytes.push(b'\n');
    output::publish(
        &out,
        &[
            ("image.igvm", &signed),
            ("public-cng.bin", &pubkey),
            ("manifest.json", &manifest_bytes),
        ],
    )?;
    println!("{manifest}");
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("REFUSED: {e}");
        std::process::exit(1);
    }
}
