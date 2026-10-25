//! Narrow V1 VSM image signing profile validated on NucBox Windows build 26200.
//! A valid signature alone does not authorize a release or attest a running VM.
//! These are format primitives for this package; the CLI also enforces independent artifact and signer pins.
use igvm::{IgvmDirectiveHeader, IgvmFile, IgvmPlatformHeader, IgvmRevision, IgvmSerializer};
use igvm_defs::IgvmPlatformType;
use p384::ecdsa::{
    signature::{Signer, Verifier},
    Signature, SigningKey, VerifyingKey,
};
use sha2::{Digest, Sha256};

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_IMAGE_BYTES: usize = 256 << 20;
pub const CNG_MAGIC: u32 = 0x33534345;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
pub fn hex32(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("expected exactly 64 lowercase hex characters".into());
    }
    let mut out = [0; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| "invalid hex")?;
    }
    Ok(out)
}
fn ensure(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}

pub struct Image {
    pub file: IgvmFile,
    pub digest: [u8; 32],
}
impl Image {
    /// Strict canonical round-trip prevents dropping unknown optional headers,
    /// padding or trailing bytes when the parser cannot preserve them.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        ensure(
            bytes.len() >= 24 && bytes.len() <= MAX_IMAGE_BYTES,
            "invalid image size",
        )?;
        ensure(
            bytes[4..8] == 1u32.to_le_bytes(),
            "only IGVM revision 1 is supported",
        )?;
        let file =
            IgvmFile::new_from_binary(bytes, None).map_err(|e| format!("invalid IGVM: {e}"))?;
        ensure(
            file.platforms().len() == 1,
            "exactly one VSM platform is required",
        )?;
        let IgvmPlatformHeader::SupportedPlatform(p) = &file.platforms()[0];
        ensure(
            p.platform_type == IgvmPlatformType::VSM_ISOLATION
                && p.compatibility_mask == 1
                && p.highest_vtl == 2
                && p.platform_version == 1
                && p.shared_gpa_boundary == 0,
            "unsupported VSM platform profile",
        )?;
        let mut roundtrip = Vec::new();
        file.serialize(&mut roundtrip)
            .map_err(|e| format!("serialize: {e}"))?;
        ensure(
            roundtrip == bytes,
            "input is not losslessly canonical; refusing to rewrite it",
        )?;
        drop(roundtrip);
        let serializer = IgvmSerializer::new(&file).map_err(|e| format!("measure: {e}"))?;
        let measurement = serializer
            .measurement_for(IgvmPlatformType::VSM_ISOLATION)
            .ok_or("no VSM launch measurement")?;
        ensure(
            measurement.compatibility_mask == 1,
            "unexpected measurement compatibility mask",
        )?;
        let digest: [u8; 32] = measurement
            .digest
            .as_slice()
            .try_into()
            .map_err(|_| "invalid VSM digest length")?;
        Ok(Self { file, digest })
    }
    pub fn identity(&self) -> Result<Option<Identity>> {
        let mut found = None;
        for directive in self.file.directives() {
            if let IgvmDirectiveHeader::VbsMeasurement {
                compatibility_mask,
                version,
                product_id,
                module_id,
                security_version,
                policy_flags,
                boot_digest_algo,
                signing_algo,
                boot_measurement_digest,
                signature,
                public_key,
            } = directive
            {
                ensure(found.is_none(), "multiple VBS identity directives")?;
                ensure(
                    *compatibility_mask == 1
                        && *version == 1
                        && *policy_flags == 0
                        && *boot_digest_algo == 1
                        && *signing_algo == 1,
                    "unsupported VBS identity profile",
                )?;
                ensure(
                    boot_measurement_digest[..32] == self.digest
                        && boot_measurement_digest[32..].iter().all(|b| *b == 0),
                    "identity launch digest differs from the computed image measurement",
                )?;
                ensure(
                    signature[96..].iter().all(|b| *b == 0)
                        && public_key[104..].iter().all(|b| *b == 0),
                    "nonzero signature or public-key padding",
                )?;
                ensure(
                    public_key[..4] == CNG_MAGIC.to_le_bytes()
                        && public_key[4..8] == 48u32.to_le_bytes(),
                    "invalid P384 CNG public key",
                )?;
                let mut point = [0u8; 97];
                point[0] = 4;
                point[1..].copy_from_slice(&public_key[8..104]);
                let key = VerifyingKey::from_sec1_bytes(&point)
                    .map_err(|_| "invalid P384 public point")?;
                let sig = Signature::from_slice(&signature[..96])
                    .map_err(|_| "invalid P384 signature encoding")?;
                let payload =
                    signed_payload(*product_id, *module_id, *security_version, &self.digest);
                // p384::ecdsa's DigestPrimitive is SHA384, matching the hardware control.
                key.verify(&payload, &sig)
                    .map_err(|_| "VBS image SHA384/P384 signature failed")?;
                found = Some(Identity {
                    signer: hash(&public_key[..104]),
                    product_id: *product_id,
                    module_id: *module_id,
                    svn: *security_version,
                });
            }
        }
        Ok(found)
    }
    pub fn sign(
        &self,
        key: &SigningKey,
        product_id: u32,
        module_id: u32,
        svn: u32,
    ) -> Result<Vec<u8>> {
        ensure(
            svn >= 13,
            "native signing profile requires an SVN floor of at least 13",
        )?;
        ensure(
            !self
                .file
                .directives()
                .iter()
                .any(|d| matches!(d, IgvmDirectiveHeader::VbsMeasurement { .. })),
            "refusing to replace or append to an existing VBS identity",
        )?;
        let payload = signed_payload(product_id, module_id, svn, &self.digest);
        let sig: Signature = key.sign(&payload);
        key.verifying_key()
            .verify(&payload, &sig)
            .map_err(|_| "signing self-check failed")?;
        let mut signature = Box::new([0; 256]);
        signature[..96].copy_from_slice(&sig.to_bytes());
        let mut public_key = Box::new([0; 512]);
        public_key[..104].copy_from_slice(&public_blob(key.verifying_key()));
        let mut boot_measurement_digest = Box::new([0; 64]);
        boot_measurement_digest[..32].copy_from_slice(&self.digest);
        let mut directives = self.file.directives().to_vec();
        directives.push(IgvmDirectiveHeader::VbsMeasurement {
            compatibility_mask: 1,
            version: 1,
            product_id,
            module_id,
            security_version: svn,
            policy_flags: 0,
            boot_digest_algo: 1,
            signing_algo: 1,
            boot_measurement_digest,
            signature,
            public_key,
        });
        let file = IgvmFile::new(
            IgvmRevision::V1,
            self.file.platforms().to_vec(),
            self.file.initializations().to_vec(),
            directives,
        )
        .map_err(|e| format!("signed IGVM structure: {e}"))?;
        let mut output = Vec::new();
        file.serialize(&mut output)
            .map_err(|e| format!("serialize signed image: {e}"))?;
        let parsed = Self::parse(&output)?;
        ensure(
            self.file.platforms() == parsed.file.platforms()
                && self.file.initializations() == parsed.file.initializations()
                && parsed.file.directives().len() == self.file.directives().len() + 1
                && self.file.directives()
                    == &parsed.file.directives()[..self.file.directives().len()],
            "signing changed original IGVM objects",
        )?;
        ensure(
            self.digest == parsed.digest,
            "signing changed the launch measurement",
        )?;
        let identity = parsed.identity()?.ok_or("signed image has no identity")?;
        ensure(
            identity.signer == hash(&public_blob(key.verifying_key()))
                && identity.product_id == product_id
                && identity.module_id == module_id
                && identity.svn == svn,
            "signed identity round-trip failed",
        )?;
        Ok(output)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub signer: String,
    pub product_id: u32,
    pub module_id: u32,
    pub svn: u32,
}
pub fn public_blob(key: &VerifyingKey) -> [u8; 104] {
    let point = key.to_encoded_point(false);
    let mut blob = [0u8; 104];
    blob[..4].copy_from_slice(&CNG_MAGIC.to_le_bytes());
    blob[4..8].copy_from_slice(&48u32.to_le_bytes());
    blob[8..].copy_from_slice(&point.as_bytes()[1..]);
    blob
}
pub fn signed_payload(product: u32, module: u32, svn: u32, digest: &[u8; 32]) -> [u8; 60] {
    let mut out = [0u8; 60];
    for (i, v) in [1, product, module, svn, 0, 1, 1].iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    out[28..].copy_from_slice(digest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use igvm_defs::{IgvmPageDataFlags, IgvmPageDataType, IGVM_VHS_SUPPORTED_PLATFORM};
    use p384::ecdsa::signature::hazmat::PrehashSigner;
    fn key() -> SigningKey {
        static KEY: std::sync::OnceLock<SigningKey> = std::sync::OnceLock::new();
        KEY.get_or_init(|| SigningKey::random(&mut p384::elliptic_curve::rand_core::OsRng))
            .clone()
    } // One ephemeral test key per process; no published private scalar.
    fn serialize(directives: Vec<IgvmDirectiveHeader>, platform: IgvmPlatformHeader) -> Vec<u8> {
        let file = IgvmFile::new(IgvmRevision::V1, vec![platform], vec![], directives).unwrap();
        let mut out = Vec::new();
        file.serialize(&mut out).unwrap();
        out
    }
    fn platform() -> IgvmPlatformHeader {
        IgvmPlatformHeader::SupportedPlatform(IGVM_VHS_SUPPORTED_PLATFORM {
            compatibility_mask: 1,
            highest_vtl: 2,
            platform_type: IgvmPlatformType::VSM_ISOLATION,
            platform_version: 1,
            shared_gpa_boundary: 0,
        })
    }
    fn unsigned() -> Vec<u8> {
        serialize(
            vec![IgvmDirectiveHeader::PageData {
                gpa: 0x1000,
                compatibility_mask: 1,
                flags: IgvmPageDataFlags::new(),
                data_type: IgvmPageDataType::NORMAL,
                data: vec![42; 4096],
            }],
            platform(),
        )
    }
    fn signed() -> Vec<u8> {
        Image::parse(&unsigned())
            .unwrap()
            .sign(&key(), 1818455653, 1734437220, 13)
            .unwrap()
    }
    fn mutate(f: impl FnOnce(&mut Vec<IgvmDirectiveHeader>)) -> Result<Option<Identity>> {
        let image = Image::parse(&signed()).unwrap();
        let mut d = image.file.directives().to_vec();
        f(&mut d);
        Image::parse(&serialize(d, platform()))?.identity()
    }
    #[test]
    fn signs_deterministically_preserves_all_objects_and_launch_digest() {
        let input = unsigned();
        let original = Image::parse(&input).unwrap();
        assert_eq!(original.identity().unwrap(), None);
        let output = original.sign(&key(), 1818455653, 1734437220, 13).unwrap();
        assert_eq!(output, signed());
        let checked = Image::parse(&output).unwrap();
        assert_eq!(checked.digest, original.digest);
        assert_eq!(
            &checked.file.directives()[..original.file.directives().len()],
            original.file.directives()
        );
        assert_eq!(
            checked.identity().unwrap(),
            Some(Identity {
                signer: hash(&public_blob(key().verifying_key())),
                product_id: 1818455653,
                module_id: 1734437220,
                svn: 13
            })
        );
        assert!(checked
            .sign(&key(), 1, 2, 14)
            .unwrap_err()
            .contains("existing VBS identity"));
        assert!(original
            .sign(&key(), 1, 2, 12)
            .unwrap_err()
            .contains("SVN floor"));
    }
    #[test]
    fn refuses_signature_fields_padding_changed_payload_and_changed_pages() {
        for case in 0..16 {
            let result = mutate(|d| {
                if case == 15 {
                    if let IgvmDirectiveHeader::PageData { data, .. } = &mut d[0] {
                        data[10] ^= 1;
                    }
                    return;
                }
                if let IgvmDirectiveHeader::VbsMeasurement {
                    compatibility_mask,
                    version,
                    product_id,
                    module_id,
                    security_version,
                    policy_flags,
                    boot_digest_algo,
                    signing_algo,
                    boot_measurement_digest,
                    signature,
                    public_key,
                } = d.last_mut().unwrap()
                {
                    match case {
                        0 => *compatibility_mask = 2,
                        1 => *version = 2,
                        2 => *product_id ^= 1,
                        3 => *module_id ^= 1,
                        4 => *security_version += 1,
                        5 => *policy_flags = 1,
                        6 => *boot_digest_algo = 2,
                        7 => *signing_algo = 2,
                        8 => boot_measurement_digest[0] ^= 1,
                        9 => boot_measurement_digest[32] = 1,
                        10 => signature[0] ^= 1,
                        11 => signature[96] = 1,
                        12 => public_key[0] ^= 1,
                        13 => public_key[104] = 1,
                        14 => public_key[8] ^= 1,
                        _ => unreachable!(),
                    }
                }
            });
            let error = result.unwrap_err();
            let expected = match case {
                0 | 1 | 5 | 6 | 7 => "unsupported VBS identity profile",
                2 | 3 | 4 | 10 => "SHA384/P384 signature failed",
                8 | 9 | 15 => "identity launch digest differs",
                11 | 13 => "nonzero signature or public-key padding",
                12 => "invalid P384 CNG public key",
                14 => "P384",
                _ => unreachable!(),
            };
            assert!(error.contains(expected), "case {case}: {error}");
        }
    }
    #[test]
    fn rejects_sha256_signature_even_when_all_other_fields_are_valid() {
        assert!(mutate(|d| {
            if let IgvmDirectiveHeader::VbsMeasurement {
                product_id,
                module_id,
                security_version,
                boot_measurement_digest,
                signature,
                ..
            } = d.last_mut().unwrap()
            {
                let digest = boot_measurement_digest[..32].try_into().unwrap();
                let data = signed_payload(*product_id, *module_id, *security_version, &digest);
                let wrong: Signature = key().sign_prehash(&Sha256::digest(data)).unwrap();
                signature[..96].copy_from_slice(&wrong.to_bytes());
            }
        })
        .is_err());
    }
    #[test]
    fn refuses_duplicate_identity_and_non_vsm_or_vtl0_platform() {
        assert!(mutate(|d| d.push(d.last().unwrap().clone())).is_err());
        let original = Image::parse(&unsigned()).unwrap();
        let IgvmPlatformHeader::SupportedPlatform(mut p) = platform();
        p.highest_vtl = 0;
        assert!(Image::parse(&serialize(
            original.file.directives().to_vec(),
            IgvmPlatformHeader::SupportedPlatform(p)
        ))
        .is_err());
        p.highest_vtl = 2;
        p.platform_type = IgvmPlatformType::NATIVE;
        assert!(Image::parse(&serialize(
            original.file.directives().to_vec(),
            IgvmPlatformHeader::SupportedPlatform(p)
        ))
        .is_err());
    }

    #[test]
    fn refuses_other_masks_and_multiple_platforms() {
        let original = Image::parse(&unsigned()).unwrap();
        let IgvmPlatformHeader::SupportedPlatform(mut alternate) = platform();
        alternate.compatibility_mask = 2;
        let mut directives = original.file.directives().to_vec();
        if let IgvmDirectiveHeader::PageData {
            compatibility_mask, ..
        } = &mut directives[0]
        {
            *compatibility_mask = 2;
        }
        assert!(Image::parse(&serialize(
            directives,
            IgvmPlatformHeader::SupportedPlatform(alternate)
        ))
        .is_err());
        alternate.platform_type = IgvmPlatformType::NATIVE;
        alternate.highest_vtl = 0;
        let multiple = IgvmFile::new(
            IgvmRevision::V1,
            vec![platform(), IgvmPlatformHeader::SupportedPlatform(alternate)],
            vec![],
            original.file.directives().to_vec(),
        )
        .unwrap();
        let mut bytes = Vec::new();
        multiple.serialize(&mut bytes).unwrap();
        assert!(Image::parse(&bytes).is_err());
    }
    #[test]
    fn refuses_truncated_corrupt_and_trailing_data() {
        let input = unsigned();
        for n in [0, 4, 24, input.len() - 1] {
            assert!(Image::parse(&input[..n]).is_err());
        }
        let mut trailing = input.clone();
        trailing.push(0);
        assert!(Image::parse(&trailing).is_err());
        // IGVM's checksum covers headers, not all page bytes. Unsigned data
        // changes are structurally valid but change both artifact and launch
        // hashes; CLI signing requires the independent artifact hash first.
        let mut data_changed = input.clone();
        *data_changed.last_mut().unwrap() ^= 1;
        assert_ne!(
            Image::parse(&data_changed).unwrap().digest,
            Image::parse(&input).unwrap().digest
        );
        for offset in [0, 4, 8, 12, 16, 20, 32] {
            let mut changed = input.clone();
            changed[offset] ^= 1;
            assert!(Image::parse(&changed).is_err(), "offset {offset}");
        }
    }
    #[test]
    fn public_encoding_and_signed_payload_are_fixed_width() {
        let blob = public_blob(key().verifying_key());
        assert_eq!(&blob[..8], &[0x45, 0x43, 0x53, 0x33, 48, 0, 0, 0]);
        let payload = signed_payload(1, 2, 13, &[0x5a; 32]);
        assert_eq!(
            &payload[..28],
            &[1u32, 1, 2, 13, 0, 1, 1]
                .iter()
                .flat_map(|n| n.to_le_bytes())
                .collect::<Vec<_>>()
        );
        assert_eq!(&payload[28..], &[0x5a; 32]);
        for s in [
            "",
            &"A".repeat(64),
            &"a".repeat(65),
            &("a".repeat(64) + "\n"),
        ] {
            assert!(hex32(s).is_err());
        }
    }
}
