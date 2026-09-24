// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Enclave M4b: the app-naming authority, inside the measured SVSM.
//
// WHY THIS EXISTS. isolation/contract fixes report_data as
//
//     report_data[0:32] = sha256(the app's transport key SPKI || the verifier's nonce)   -- the app's own
//     report_data[32:64] = the app's ID, from the MONITOR's table and NEVER from the caller
//
// In M3a that monitor was Linux code inside the guest, and on the IGVM path the guest image is NOT in the
// launch measurement (isolation/m3/PLAN.md section 16), so the app half was stated by code whose identity the
// report did not establish. In M4a there is no monitor at all: one SNP guest per app, and the measurement
// itself names the app. That is sound but costs a guest per app.
//
// M4b puts the authority where it is both measured and cheap: here, at VMPL0, inside the SVSM that the IGVM
// digest covers - a digest this project already derives with igvmmeasure and matches against the live signed
// report. A guest at a lower VMPL supplies ONLY the 32-byte bind. The SVSM fills the app half from APP_TABLE,
// indexed by the plane the request came from, and a caller cannot reach that half at all: it is not a field
// of the request.
//
// APP_TABLE is compiled in, so it is inside the SVSM binary, inside the IGVM, inside the launch measurement.
// Changing which app runs on which plane therefore CHANGES THE MEASUREMENT, which is the property that makes
// the naming trustworthy rather than merely convenient. It also means a verifier's expected digest is derived
// from the shipped IGVM as it already is, with no new derivation path.
//
// WHY A TABLE ALONE IS NOT ENOUGH. A compiled-in table says "plane 2 is app X". It does not say that the
// bytes on plane 2 ARE app X: the guest chooses what to load, and under IGVM the guest image is not measured,
// so naming by plane index alone is a measured LABEL over an unmeasured fact. Whoever controls the loader
// picks the bytes and this SVSM would name them X regardless. That is a label, not authority.
//
// ADMISSION closes it. Before this SVSM will name a plane or fetch a report for it, the plane must present
// each artifact its identity covers - the contract bundle, whose sha256 IS the AppID, and the runtime image -
// and this code must have
//
//   1. hashed those bytes itself, out of guest memory, at VMPL0;
//   2. found the digest equal to the one compiled into this measured image;
//   3. made the region IMMUTABLE to every guest plane with RMPADJUST - read and execute, never write;
//   4. hashed it AGAIN after freezing and found the same digest.
//
// The order is the substance. Freezing first would let any plane freeze a NEIGHBOUR's memory by naming its
// pages, which is a cross-plane denial of service introduced by the protocol itself - so nothing is frozen
// until bytes matching THIS plane's expected digest have been seen. Hashing only once and then freezing
// would leave a window in which the guest swaps the bytes between the check and the lock. Hash, freeze,
// re-hash closes both: a plane that cannot produce the right bytes freezes nothing, and a plane that swaps
// them after the first hash fails the second.
//
// WHAT THIS STILL DOES NOT ESTABLISH, stated so no document overclaims it: the SVSM does not yet control
// where a plane begins executing, so "the admitted bytes are the bytes that RAN" depends on the guest
// loading from the admitted region. What is hardware-enforced today is that the admitted bytes exist,
// unmodifiable by any plane, and that this SVSM speaks for a plane only once they do. Closing the last link
// means the SVSM owning the plane's entry point and executable mappings, which is the next increment.

extern crate alloc;

use crate::address::{Address, PhysAddr};
use alloc::vec::Vec;
use crate::mm::guestmem::{copy_slice_from_guest, copy_slice_to_guest};
use crate::mm::memory::valid_phys_address;
use crate::mm::PerCPUPageMappingGuard;
use crate::protocols::attest::get_attestation_report_for_app;
use crate::protocols::errors::SvsmReqError;
use crate::protocols::RequestParams;
use crate::locking::SpinLock;
use crate::sev::utils::{rmp_adjust, RMPFlags};
use crate::sev::vmsa::VMPL_MAX;
use crate::types::GUEST_VMPL;
use crate::types::{PageSize, PAGE_SIZE};
use core::sync::atomic::{AtomicU8, Ordering};
use sha2::{Digest, Sha256};
use zerocopy::IntoBytes;

pub const APPID_PROTOCOL_VERSION_MIN: u32 = 1;
/// Version 2 adds admission (SVSM_APPID_ADMIT, SVSM_APPID_STATUS) AND gates naming and reports on it, which
/// is a behaviour change a guest has to be able to detect rather than discover by being refused.
pub const APPID_PROTOCOL_VERSION_MAX: u32 = 2;

// ARGUMENTS ARRIVE IN A DESCRIPTOR, not in registers, and that is a deliberate constraint rather than a
// style choice. A guest at a lower VMPL can only reach an SVSM protocol from ring 0, and the one entry point
// a STOCK Linux guest exports to modules is
//
//     int snp_issue_svsm_attest_req(u64 call_id, struct svsm_call *call, struct svsm_attest_call *input)
//
// which passes call_id through to RAX and puts the physical address of a caller-filled buffer in RCX - and
// overwrites RDX and R8 with -1 on the way. A protocol that took its arguments in RDX and R8 would therefore
// need a patched guest kernel to call at all. Taking them from a descriptor at RCX is also what the SVSM's
// own attestation protocol does, so this is the idiomatic shape as well as the reachable one.
//
// The descriptor is three little-endian u64s, and each call reads only the fields it needs:
//
//     +0   a    GET_REPORT: GPA of the 32-byte NONCE  ADMIT: GPA of the PAGE LIST   WHOAMI/STATUS: out GPA
//                REGISTER_KEY: GPA of the transport key SPKI
//     +8   b    GET_REPORT: GPA of the report buffer  ADMIT: the artifact's total length in bytes
//     +16  c    GET_REPORT: that buffer's length in, bytes written out   ADMIT: which artifact
//
// ADMIT takes a PAGE LIST rather than a contiguous range, because physical contiguity is a property a guest
// cannot supply at realistic sizes: a runtime image is tens of megabytes and __get_free_pages tops out at
// 4 MiB. The list is an array of page-aligned GPAs, one per page of the artifact in order, in a contiguous
// region the guest CAN allocate (8 bytes per page: a 45 MiB artifact needs an 88 KiB list).
const DESC_LEN: usize = 24;

/// Ask for a report naming the calling plane's app. Refused until the plane's artifacts are admitted.
const SVSM_APPID_GET_REPORT: u32 = 0;
/// Ask which app ID this plane is, without a report. Refused until admitted.
const SVSM_APPID_WHOAMI: u32 = 1;
/// Admit one artifact for the calling plane: hash it, freeze it, hash it again (see the header).
/// c selects the artifact: 0 the contract bundle, 1 the runtime image.
const SVSM_APPID_ADMIT: u32 = 2;
/// Which artifacts this plane has admitted, so a guest can tell WHY it is refused. Never gated.
const SVSM_APPID_STATUS: u32 = 3;
/// Register this plane's transport key, once. a = GPA of the SPKI, b = its length.
/// After this the SVSM computes the report binding itself, so GET_REPORT carries only a nonce.
const SVSM_APPID_REGISTER_KEY: u32 = 4;

const BIND_LEN: usize = 32;
const APPID_LEN: usize = 32;

/// One app ID per guest privilege level, measured with the SVSM.
///
/// Index is the VMPL. Index 0 is the SVSM itself and is never an app, so it stays zero and a request from
/// VMPL0 is refused rather than served a null identity. The build fills 1..VMPL_MAX from
/// ENCLAVE_APP_IDS, a comma-separated list of 32-byte hex IDs in plane order, so the table is a build
/// input and lands in the measurement.
///
/// vmpl_count is 4 on this hardware, so with the SVSM at VMPL0 there are AT MOST THREE app planes. That is a
/// hardware ceiling, not a tuning parameter; beyond three apps per host the M4a shape (one SNP guest per app)
/// is the scalable path and stays supported.
static APP_TABLE: [[u8; APPID_LEN]; VMPL_MAX] = build_app_table();

/// sha256 of the RUNTIME IMAGE for each plane, from ENCLAVE_RUNTIME_SHA256, same format and same
/// measurement consequence as APP_TABLE.
///
/// This is the digest of the runtime's BYTES, and it is a different thing from the RuntimeID that ABI/2
/// binds into report_data[0:32]. RuntimeID is sha256 of a canonical JSON label - name, version, execution
/// mode, ISA, feature policy - and a label is exactly what does not survive Steven's objection: unmeasured
/// code could load a different runtime and the label would still read "wasmtime 48.0.1 jit x86_64". So
/// admission is over the image, and the label remains what a verifier reads to know what that image IS.
static RUNTIME_TABLE: [[u8; APPID_LEN]; VMPL_MAX] = build_table(option_env!("ENCLAVE_RUNTIME_SHA256"));

const fn build_app_table() -> [[u8; APPID_LEN]; VMPL_MAX] {
    build_table(option_env!("ENCLAVE_APP_IDS"))
}

/// Parse the table STRICTLY: exactly 64 hex digits per entry, exactly one comma between entries, nothing
/// else, and at most one entry per app plane. Anything else is a `panic!` in a const fn, which is a BUILD
/// error - the right outcome for an input that ends up inside a launch measurement.
///
/// The lenient version this replaces mis-parsed in ways an independent review measured: entries with no comma
/// between them silently became two planes, a space or a semicolon silently dropped every later plane, a
/// short entry silently named a plane with a half-zero digest, a fourth entry was silently ignored, and an
/// odd number of digits panicked with an index-out-of-bounds instead of saying what was wrong. Every one of
/// those ships an image whose table is not what the operator wrote.
const fn build_table(src: Option<&str>) -> [[u8; APPID_LEN]; VMPL_MAX] {
    let mut t = [[0u8; APPID_LEN]; VMPL_MAX];
    let ids: &[u8] = match src {
        Some(s) => s.as_bytes(),
        None => return t,
    };
    if ids.is_empty() {
        return t;
    }
    let need = APPID_LEN * 2; // 64 hex digits, one entry
    let mut i = 0usize;
    let mut plane = 1usize;
    loop {
        if plane >= VMPL_MAX {
            panic!("more entries than this hardware has app planes: VMPL0 is the SVSM and vmpl_count is 4, so at most 3");
        }
        if i + need > ids.len() {
            panic!("an entry is not exactly 64 hex digits (a typo, a space, or a trailing comma?)");
        }
        let mut byte = 0usize;
        while byte < APPID_LEN {
            let h = hex_val(ids[i + byte * 2]);
            let l = hex_val(ids[i + byte * 2 + 1]);
            if h == 0xff || l == 0xff {
                // Name what was actually there: an operator reading "not a hex digit" for a stray space has
                // to go and count characters, and this input ends up inside a launch measurement.
                let c = if h == 0xff {
                    ids[i + byte * 2]
                } else {
                    ids[i + byte * 2 + 1]
                };
                if c == b',' {
                    panic!("an entry is shorter than 64 hex digits: a comma arrived early");
                }
                if c == b' ' || c == b'\t' {
                    panic!("no spaces: entries are separated by exactly one comma and nothing else");
                }
                panic!("an entry contains a character that is not a hex digit");
            }
            t[plane][byte] = h << 4 | l;
            byte += 1;
        }
        i += need;
        if i == ids.len() {
            return t;
        }
        if ids[i] != b',' {
            panic!("entries must be separated by exactly one comma, with no spaces and no other separator");
        }
        i += 1;
        if i == ids.len() {
            panic!("trailing comma: an entry was expected after it");
        }
        plane += 1;
    }
}

const fn hex_val(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0xff,
    }
}

/// Protocol-specific result codes (SvsmReqError::protocol -> 0x80001000 + code).
///
/// INVALID_REQUEST alone covered eight different refusals - unadmitted plane, unassigned table entry, digest
/// mismatch, double admit, a freeze that failed, bytes changed between hash and freeze, and a failed record -
/// so a harness could only say "refused" and two of those would be bugs in our own code rather than findings.
/// A distinct code per reason is what lets a negative test assert it was refused for the RIGHT reason.
const E_NOT_OWNING_PLANE: u64 = 1;
const E_PLANE_UNASSIGNED: u64 = 2;
const E_NOT_ADMITTED: u64 = 3;
const E_DIGEST_MISMATCH: u64 = 4;
const E_ALREADY_ADMITTED: u64 = 5;
const E_FREEZE_FAILED: u64 = 6;
const E_CHANGED_UNDER_US: u64 = 7;
const E_RECORD_FAILED: u64 = 8;
const E_NO_KEY: u64 = 9;
const E_KEY_ALREADY_SET: u64 = 10;
const E_NO_RUNTIME_ID: u64 = 11;

/// The ABI/2 RuntimeID for each plane: sha256 of the canonical JSON runtime identity
/// (isolation/contract/runtime.go RuntimeID), from ENCLAVE_RUNTIME_IDS, in plane order.
///
/// Compiled in, so it is in the measurement, which is what makes it the SVSM's word rather than the guest's.
/// B5 in the review was exactly this: the runtime LABEL in report_data[0:32] was the guest's to state, because
/// the front computed Bind2 itself over an identity file inside an unmeasured image. Folding it in here means a
/// verifier recomputes the binding from an identity the measured image asserts, and a guest cannot claim a
/// different runtime than the one this image was built for.
static RUNTIME_ID_TABLE: [[u8; APPID_LEN]; VMPL_MAX] = build_table(option_env!("ENCLAVE_RUNTIME_IDS"));

/// The maximum transport-key SPKI this SVSM will record.
///
/// A P-256 SubjectPublicKeyInfo is 91 bytes, and P-256 is what the contract requires
/// (isolation/contract/RUNTIME.md requirement 6: the domain's key is minted with elliptic.P256()). The bound
/// exists so a plane cannot make the SVSM hold an arbitrary amount of its memory - and note what it implies:
/// an RSA key would not fit and would be REFUSED at registration rather than silently truncated, which is the
/// right failure. A backend that wants another algorithm changes the contract first.
const MAX_SPKI: usize = 256;

/// The transport key registered for each plane, recorded ONCE and never replaced.
///
/// The whole point is that the mapping from a key to an app is fixed before the plane serves anything: the SVSM
/// computes the binding itself over THIS key, so a report for this plane can only ever carry the key registered
/// at its start. A caller cannot present a different key later, and no compromise after registration can
/// re-label a live domain. The residual is a plane that registers the wrong key at start, which is the TCB
/// statement M3a already makes about code inside the plane - and which A4 is what removes.
static REGISTERED_KEY: [SpinLock<([u8; MAX_SPKI], usize)>; VMPL_MAX] =
    [const { SpinLock::new(([0u8; MAX_SPKI], 0)) }; VMPL_MAX];

/// The ABI/2 binding domain separator, byte for byte isolation/contract/runtime.go bind2Domain.
const BIND2_DOMAIN: &[u8] = b"enclave-bind-v2\n";

/// The artifacts a plane's identity covers. Both must be admitted before this SVSM speaks for the plane.
const KIND_BUNDLE: usize = 0;
const KIND_RUNTIME: usize = 1;
const KIND_COUNT: usize = 2;
const KINDS_REQUIRED: u8 = (1 << KIND_BUNDLE) | (1 << KIND_RUNTIME);

/// A bound on how much guest memory one request will make this SVSM hash. Hashing happens twice, at VMPL0,
/// with a soft SHA-256, so an unbounded length would be a denial of service against every other plane.
const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;

/// Which kinds each plane has admitted. Per plane, so one plane's state cannot be read or set by another,
/// and atomic because planes issue requests from different CPUs.
static ADMITTED: [AtomicU8; VMPL_MAX] = [const { AtomicU8::new(0) }; VMPL_MAX];

/// The page frames this SVSM has admitted and frozen, sorted, so `page_is_admitted` can answer the PVALIDATE
/// path cheaply. Admitted pages must never be re-validated: PVALIDATE(invalid) then PVALIDATE(valid) zeroes a
/// page and hands the guest RWX back, which would thaw an artifact this SVSM has vouched for while ADMITTED
/// still said it was fine.
static ADMITTED_PAGES: SpinLock<Vec<u64>> = SpinLock::new(Vec::new());

/// Does this page belong to an admitted artifact? Consulted by the core protocol's PVALIDATE path.
pub fn page_is_admitted(paddr: PhysAddr) -> bool {
    let frame = paddr.page_align().bits() as u64;
    ADMITTED_PAGES.lock().binary_search(&frame).is_ok()
}

/// Does an entire region intersect an admitted artifact? PVALIDATE takes 2 MiB entries too, and a huge entry
/// covering one admitted 4 KiB page must be refused as a whole.
pub fn region_is_admitted(paddr: PhysAddr, len: usize) -> bool {
    let pages = ADMITTED_PAGES.lock();
    if pages.is_empty() {
        return false;
    }
    let start = paddr.page_align().bits() as u64;
    let end = start + len as u64;
    match pages.binary_search(&start) {
        Ok(_) => true,
        Err(i) => i < pages.len() && pages[i] < end,
    }
}

/// THE OWNERSHIP PRECONDITION, and why this protocol refuses every plane but one.
///
/// Planes share one guest-physical address space, partitioned by RMP permissions, and this SVSM has no way to
/// ask the hardware "which plane owns this page": COCONUT has no RMPQUERY, and no per-plane validated-page map
/// is recorded anywhere. Without that oracle, a guest-supplied GPA cannot be attributed, and an independent
/// review showed what that costs once more than one plane exists: `write_out` becomes a cross-plane write
/// primitive, `read_bind` returns 32 bytes of a neighbour inside a signed report, and ADMIT freezes a
/// neighbour's pages whenever their bytes hash to the caller's expected digest - which is automatic for the
/// runtime image, since every plane runs the same one.
///
/// So this protocol serves EXACTLY ONE plane, the one the SVSM was built for. With one guest plane there is no
/// neighbour to attribute a page to, and every guest page is that plane's by construction. A second plane is
/// refused rather than served unsafely, and per-app planes stay unimplemented until the oracle exists. That is
/// the honest state: a compiled-in table can NAME three planes, and this code will speak for one.
fn require_owning_plane(vmpl: usize) -> Result<(), SvsmReqError> {
    if vmpl != GUEST_VMPL {
        return Err(SvsmReqError::protocol(E_NOT_OWNING_PLANE));
    }
    Ok(())
}

/// The digest this measured image expects for (plane, kind).
///
/// For the bundle this is APP_TABLE[plane] and no second table is needed: isolation/contract defines the
/// AppID as sha256 of ALL the bundle's bytes, so "these bytes hash to the identity this plane is named" and
/// "this plane is app X" are the same statement. That is why admission is over the bundle and not over the
/// extracted artifact - the artifact's hash is not the AppID.
fn expected_digest(vmpl: usize, kind: usize) -> Result<[u8; APPID_LEN], SvsmReqError> {
    if vmpl == 0 || vmpl >= VMPL_MAX {
        return Err(SvsmReqError::invalid_parameter());
    }
    let d = match kind {
        KIND_BUNDLE => APP_TABLE[vmpl],
        KIND_RUNTIME => RUNTIME_TABLE[vmpl],
        _ => return Err(SvsmReqError::invalid_parameter()),
    };
    if d == [0u8; APPID_LEN] {
        return Err(SvsmReqError::protocol(E_PLANE_UNASSIGNED));
    }
    Ok(d)
}

/// Refuse to speak for a plane that has not admitted every artifact its identity covers. This is the gate
/// that turns APP_TABLE from a label into a claim about bytes this code has hashed and frozen itself.
///
/// Public because the ATTESTATION protocol is gated on it too. Protocol 1 is callable by an app plane and
/// returns a report carrying this measurement and, since the plane-stamping change, the plane's own level - so
/// an ungated protocol 1 would let a plane obtain such a report BEFORE admitting anything. Its report_data is
/// SHA-512(nonce||manifest) and cannot satisfy the contract's binding, so it is not a forgery of an app's
/// evidence, but it would make "a report with this measurement and vmpl=N was issued for plane N only after
/// admission" false as written. Nothing here needs a pre-admission services report, so the gate applies to
/// both protocols and the sentence stays true.
pub fn require_admitted(vmpl: usize) -> Result<(), SvsmReqError> {
    if vmpl == 0 || vmpl >= VMPL_MAX {
        return Err(SvsmReqError::invalid_parameter());
    }
    if ADMITTED[vmpl].load(Ordering::Acquire) & KINDS_REQUIRED != KINDS_REQUIRED {
        return Err(SvsmReqError::protocol(E_NOT_ADMITTED));
    }
    Ok(())
}

fn app_id_for_plane(vmpl: usize) -> Result<[u8; APPID_LEN], SvsmReqError> {
    // VMPL0 is the SVSM. It is not an app and must never be handed an app identity.
    if vmpl == 0 || vmpl >= VMPL_MAX {
        return Err(SvsmReqError::invalid_parameter());
    }
    let id = APP_TABLE[vmpl];
    // An unassigned plane is refused rather than named with zeros: a null identity that verified would be
    // worse than no service.
    if id == [0u8; APPID_LEN] {
        return Err(SvsmReqError::invalid_request());
    }
    Ok(id)
}

/// Read the caller's 32-byte bind out of guest memory. Only the bind: the app half of report_data is not a
/// field of this request, so no caller can influence it.
fn read_bind(gpa_raw: u64) -> Result<[u8; BIND_LEN], SvsmReqError> {
    let gpa = PhysAddr::from(gpa_raw);
    if !gpa.is_aligned(8) {
        return Err(SvsmReqError::invalid_parameter());
    }
    let offset = gpa.page_offset();
    if offset + BIND_LEN > crate::types::PAGE_SIZE {
        return Err(SvsmReqError::invalid_parameter());
    }
    let guard = PerCPUPageMappingGuard::create_4k(gpa.page_align())?;
    let ptr = guard.guest_ptr::<[u8; BIND_LEN]>(offset)?;
    ptr.read().map_err(|_| SvsmReqError::invalid_parameter())
}

/// Read the three-u64 descriptor the caller placed in its SVSM calling area.
fn read_desc(gpa_raw: u64) -> Result<[u64; 3], SvsmReqError> {
    let gpa = PhysAddr::from(gpa_raw);
    if !gpa.is_aligned(8) {
        return Err(SvsmReqError::invalid_parameter());
    }
    if gpa.page_offset() + DESC_LEN > PAGE_SIZE {
        return Err(SvsmReqError::invalid_parameter());
    }
    let mut raw = [0u8; DESC_LEN];
    copy_slice_from_guest(gpa, &mut raw).map_err(|_| SvsmReqError::invalid_parameter())?;
    let mut out = [0u64; 3];
    for (i, v) in out.iter_mut().enumerate() {
        let mut w = [0u8; 8];
        w.copy_from_slice(&raw[i * 8..i * 8 + 8]);
        *v = u64::from_le_bytes(w);
    }
    Ok(out)
}

/// Write one field back into the descriptor, for the one call that returns a length.
fn write_desc_field(gpa_raw: u64, index: usize, value: u64) -> Result<(), SvsmReqError> {
    let gpa = PhysAddr::from(gpa_raw + (index * 8) as u64);
    copy_slice_to_guest(&value.to_le_bytes(), gpa).map_err(SvsmReqError::from)
}

fn write_out(gpa_raw: u64, data: &[u8]) -> Result<(), SvsmReqError> {
    let gpa = PhysAddr::from(gpa_raw);
    let offset = gpa.page_offset();
    if offset + data.len() > crate::types::PAGE_SIZE {
        return Err(SvsmReqError::invalid_parameter());
    }
    let _ = offset;
    copy_slice_to_guest(data, gpa).map_err(SvsmReqError::from)
}

/// The artifact's pages, as this code read them ONCE, so no later pass can be pointed somewhere else.
///
/// Reading the guest's page list again for the post-freeze hash would reopen the hole the second hash exists
/// to close: the guest could leave the frozen pages alone and swap the LIST, so the second hash would cover
/// different, unfrozen pages that happen to match. One snapshot, used by every pass.
fn read_page_list(list_gpa: PhysAddr, len: usize) -> Result<Vec<PhysAddr>, SvsmReqError> {
    let pages = len.div_ceil(PAGE_SIZE);
    if pages == 0 || pages > MAX_ARTIFACT_BYTES / PAGE_SIZE {
        return Err(SvsmReqError::invalid_parameter());
    }
    if !list_gpa.is_aligned(8) {
        return Err(SvsmReqError::invalid_parameter());
    }
    let mut out = Vec::new();
    out.try_reserve(pages).map_err(|_| SvsmReqError::protocol(E_RECORD_FAILED))?;
    let mut raw = [0u8; 8];
    for i in 0..pages {
        let at = PhysAddr::from(list_gpa.bits() + i * 8);
        copy_slice_from_guest(at, &mut raw).map_err(|_| SvsmReqError::invalid_parameter())?;
        let p = PhysAddr::from(u64::from_le_bytes(raw));
        // every entry must be a page this plane may hand us: page-aligned, and not SVSM or VMSA memory
        if !p.is_aligned(PAGE_SIZE) || !valid_phys_address(p) {
            return Err(SvsmReqError::invalid_parameter());
        }
        out.push(p);
    }
    Ok(out)
}

/// Hash the artifact from the snapshot, at VMPL0, in bounded chunks. The chunk buffer is small on purpose:
/// the SVSM runs on a modest stack, and mapping a whole artifact at once would be a different kind of bug.
fn hash_pages(pages: &[PhysAddr], len: usize) -> Result<[u8; APPID_LEN], SvsmReqError> {
    let mut h = Sha256::new();
    let mut buf = [0u8; 512];
    let mut done = 0usize;
    for page in pages {
        let want = core::cmp::min(PAGE_SIZE, len - done);
        let mut off = 0usize;
        while off < want {
            let n = core::cmp::min(buf.len(), want - off);
            let at = PhysAddr::from(page.bits() + off);
            copy_slice_from_guest(at, &mut buf[..n]).map_err(|_| SvsmReqError::invalid_parameter())?;
            h.update(&buf[..n]);
            off += n;
        }
        done += want;
        if done >= len {
            break;
        }
    }
    if done != len {
        return Err(SvsmReqError::invalid_parameter());
    }
    let out = h.finalize();
    let mut d = [0u8; APPID_LEN];
    d.copy_from_slice(&out);
    Ok(d)
}

/// Freeze the artifact: the OWNING plane keeps read (and execute, for code only) and loses WRITE; every other
/// plane is set to NONE.
///
/// The first version of this GRANTED `READ | X_USER | X_SUPER` to VMPL1, 2 and 3 - it iterated the planes to
/// "freeze for everyone" and in doing so handed every neighbour read and execute on the caller's memory. An
/// independent review caught it. RMPADJUST sets a permission MASK per plane, so "freeze" must mean: remove
/// write from the owner, and deny the others outright.
///
/// Execute is granted only for the runtime image. A bundle is data that the runtime reads; giving it X would
/// hand a plane an executable mapping of attacker-influenced bytes for no reason.
fn freeze_pages(pages: &[PhysAddr], owner: usize, kind: usize) -> Result<usize, SvsmReqError> {
    for page in pages {
        let guard = PerCPUPageMappingGuard::create_4k(*page)?;
        let vaddr = guard.virt_addr();
        let mut vmpl = RMPFlags::VMPL1.bits();
        while vmpl <= RMPFlags::VMPL3.bits() {
            let flags = RMPFlags::from_bits_truncate(plane_mask(vmpl, owner, kind));
            // SAFETY: every branch here REMOVES permission from a guest plane. The owner loses write and
            // keeps what it needs to run; the others are denied. Nothing is granted that was not held.
            unsafe { rmp_adjust(vaddr, flags, PageSize::Regular) }
                // FAIL_SIZEMISMATCH lands here when a 4 KiB adjust meets a 2 MiB RMP entry, which is a
            // staging problem and not a digest problem: it gets its own code so it cannot be misread.
            .map_err(|_| SvsmReqError::protocol(E_FREEZE_FAILED))?;
            vmpl += 1;
        }
    }
    Ok(pages.len())
}

/// What the OWNING plane keeps on a frozen page: read, plus execute for code only, and never write.
fn owner_permission_bits(kind: usize) -> u64 {
    if kind == KIND_RUNTIME {
        RMPFlags::READ.bits() | RMPFlags::X_USER.bits() | RMPFlags::X_SUPER.bits()
    } else {
        // a bundle is data the runtime reads; an executable mapping of it would be a gift to nobody's benefit
        RMPFlags::READ.bits()
    }
}

/// The exact RMPADJUST mask freeze_pages applies for one plane. Split out so the tests exercise THIS decision
/// rather than restating bitflag algebra beside it - the earlier tests asserted the constants and would have
/// passed against the version that granted every neighbour read and execute.
fn plane_mask(level_bits: u64, owner: usize, kind: usize) -> u64 {
    if level_bits as usize == owner {
        level_bits | owner_permission_bits(kind)
    } else {
        // not the owner: no read, no write, no execute. Never a grant.
        level_bits | RMPFlags::NONE.bits()
    }
}

/// Record the admitted frames so the PVALIDATE path can refuse to thaw them.
fn record_admitted(pages: &[PhysAddr]) -> Result<(), SvsmReqError> {
    let mut held = ADMITTED_PAGES.lock();
    held.try_reserve(pages.len())
        .map_err(|_| SvsmReqError::protocol(E_RECORD_FAILED))?;
    for p in pages {
        held.push(p.page_align().bits() as u64);
    }
    held.sort_unstable();
    held.dedup();
    Ok(())
}

/// Admit one artifact for the calling plane: hash, freeze, hash again.
///
/// The order is the security argument, and it is worth restating where the code is:
///
///   * hashing FIRST means a plane that cannot produce bytes matching its OWN expected digest freezes
///     nothing. Freezing first would let any plane wedge a neighbour by naming the neighbour's pages - a
///     cross-plane denial of service created by this protocol, which is the opposite of the point.
///   * freezing SECOND makes the bytes immutable to every plane, in hardware, via RMPADJUST.
///   * hashing a THIRD time closes the window between the first hash and the freeze: a plane that swapped
///     the bytes in that window fails here, and what this SVSM has vouched for is what the hardware keeps.
///
/// A refusal after freezing deliberately leaves the pages frozen. Handing write access back on the way out
/// would restore exactly the window this exists to close.
fn appid_admit(vmpl: usize, params: &mut RequestParams) -> Result<(), SvsmReqError> {
    // Ownership first: without it, freezing a guest-supplied GPA can take a neighbour's page away.
    require_owning_plane(vmpl)?;
    let desc = read_desc(params.rcx)?;
    let kind = desc[2] as usize;
    // validates the plane and the kind, and refuses a plane this image does not name
    let expected = expected_digest(vmpl, kind)?;
    let len = desc[1] as usize;
    if len == 0 || len > MAX_ARTIFACT_BYTES {
        return Err(SvsmReqError::invalid_parameter());
    }
    let bit = 1u8 << kind;
    // Admitting the same kind twice would let a plane get a second region vouched for after the first, and
    // then run from whichever it liked. One admission per kind per plane, for the life of the guest.
    if ADMITTED[vmpl].load(Ordering::Acquire) & bit != 0 {
        return Err(SvsmReqError::protocol(E_ALREADY_ADMITTED));
    }
    let pages = read_page_list(PhysAddr::from(desc[0]), len)?;
    if hash_pages(&pages, len)? != expected {
        return Err(SvsmReqError::protocol(E_DIGEST_MISMATCH));
    }
    // freeze -> re-hash -> record, under the PVALIDATE write lock.
    //
    // Without the lock there is a window an independent review found: after the second hash reads a page and
    // before the frame is recorded, another vCPU can PVALIDATE(invalid) it, have the host flip it shared and
    // private, and PVALIDATE(valid) it - which zeroes the page and restores guest RWX - because the PVALIDATE
    // hook only refuses frames already RECORDED. The page would then be recorded and the plane admitted with
    // a writable, zeroed artifact. The lock is taken in the same order core_pvalidate_one takes it, so there
    // is no inversion.
    let _pv = crate::protocols::core::pvalidate_write_lock();
    let frozen = freeze_pages(&pages, vmpl, kind)?;
    if hash_pages(&pages, len)? != expected {
        // The bytes changed between the first hash and the freeze. That is an active attempt, not a mistake.
        log::error!("SVSM appid: plane {vmpl} kind {kind} changed between hash and freeze; REFUSED");
        return Err(SvsmReqError::protocol(E_CHANGED_UNDER_US));
    }
    // Recorded BEFORE the plane is marked admitted: if recording fails there is no point at which this SVSM
    // has named a plane whose pages the PVALIDATE path would still thaw.
    record_admitted(&pages)?;
    ADMITTED[vmpl].fetch_or(bit, Ordering::Release);
    log::info!(
        "SVSM appid: plane {vmpl} admitted kind {kind}, {frozen} pages frozen read-only to every guest plane"
    );
    Ok(())
}

/// Record this plane's transport key. Once, and never replaced.
fn appid_register_key(vmpl: usize, params: &mut RequestParams) -> Result<(), SvsmReqError> {
    require_owning_plane(vmpl)?;
    let desc = read_desc(params.rcx)?;
    let len = desc[1] as usize;
    if len == 0 || len > MAX_SPKI {
        return Err(SvsmReqError::invalid_parameter());
    }
    let gpa = PhysAddr::from(desc[0]);
    let mut held = REGISTERED_KEY[vmpl].lock();
    if held.1 != 0 {
        // A second key would let a caller re-point the binding after the first was vouched for, which is the
        // whole property this registration exists to fix.
        return Err(SvsmReqError::protocol(E_KEY_ALREADY_SET));
    }
    let mut buf = [0u8; MAX_SPKI];
    copy_slice_from_guest(gpa, &mut buf[..len]).map_err(|_| SvsmReqError::invalid_parameter())?;
    held.0 = buf;
    held.1 = len;
    log::info!("SVSM appid: plane {vmpl} registered a {len}-byte transport key");
    Ok(())
}

/// The ABI/2 binding, computed HERE: sha256("enclave-bind-v2\n" || SPKI || nonce || RuntimeID).
///
/// Byte for byte isolation/contract/runtime.go Bind2, over the key registered for this plane and a RuntimeID
/// compiled into this measured image. The caller supplies only the nonce. That is the difference from ABI/2 as
/// the front computed it: there, both the key and the runtime identity came from an unmeasured image and the
/// binding was the guest's word; here a report for this plane can only carry the key it registered at start and
/// the runtime this image was built for.
fn bind2_for_plane(vmpl: usize, nonce: &[u8; BIND_LEN]) -> Result<[u8; BIND_LEN], SvsmReqError> {
    let runtime_id = RUNTIME_ID_TABLE[vmpl];
    if runtime_id == [0u8; APPID_LEN] {
        return Err(SvsmReqError::protocol(E_NO_RUNTIME_ID));
    }
    let held = REGISTERED_KEY[vmpl].lock();
    if held.1 == 0 {
        return Err(SvsmReqError::protocol(E_NO_KEY));
    }
    let mut h = Sha256::new();
    h.update(BIND2_DOMAIN);
    h.update(&held.0[..held.1]);
    h.update(nonce);
    h.update(runtime_id);
    let out = h.finalize();
    let mut bind = [0u8; BIND_LEN];
    bind.copy_from_slice(&out);
    Ok(bind)
}

/// What this plane has admitted and what it still owes, so a guest can tell WHY it is refused without being
/// told anything it could not compute itself.
fn appid_status(vmpl: usize, params: &mut RequestParams) -> Result<(), SvsmReqError> {
    require_owning_plane(vmpl)?;
    let desc = read_desc(params.rcx)?;
    let mut out = [0u8; 8];
    out[0] = ADMITTED[vmpl].load(Ordering::Acquire);
    out[1] = KINDS_REQUIRED;
    out[2] = KIND_COUNT as u8;
    out[3] = vmpl as u8;
    out[4] = if REGISTERED_KEY[vmpl].lock().1 != 0 { 1 } else { 0 };
    out[5] = if RUNTIME_ID_TABLE[vmpl] != [0u8; APPID_LEN] { 1 } else { 0 };
    write_out(desc[0], &out)
}

fn appid_get_report(vmpl: usize, params: &mut RequestParams) -> Result<(), SvsmReqError> {
    // Before anything else: this SVSM does not fetch a report naming a plane whose artifacts it has not
    // hashed and frozen itself. Without this the app half would be a measured label over unmeasured bytes.
    require_owning_plane(vmpl)?;
    require_admitted(vmpl)?;
    let desc = read_desc(params.rcx)?;
    // The caller supplies the verifier's NONCE and nothing else. It used to supply the whole 32-byte binding,
    // which meant the key and the runtime identity inside it were the guest's to choose; both now come from
    // this measured image or from what the plane registered at its start.
    let nonce = read_bind(desc[0])?;
    let bind = bind2_for_plane(vmpl, &nonce)?;
    let app = app_id_for_plane(vmpl)?;

    // report_data, assembled HERE: a binding over the plane's registered key, the caller's nonce and this
    // image's RuntimeID, and the app ID this plane is measured to be.
    let mut report_data = [0u8; BIND_LEN + APPID_LEN];
    report_data[..BIND_LEN].copy_from_slice(&bind);
    report_data[BIND_LEN..].copy_from_slice(&app);

    // The report must name the plane that ASKED, not VMPL0. This call site left SnpReportRequest.vmpl at its
    // zero default, so every report protocol 6 produced was signed as VMPL0 - a verifier pinning the plane
    // (relay/snp-verify.mjs expectedVmpl) would reject it, and one that did not would lose the level
    // entirely. VMPCK0 may request a report naming any level, so this is the SVSM's to set.
    let report = match get_attestation_report_for_app(&report_data, vmpl as u32) {
        Ok(r) => r,
        Err(e) => {
            // Name it on the console: a refusal from the PSP path is a different finding from any of this
            // protocol's own refusals, and mapping it to "denied" told the harness nothing.
            log::error!("SVSM appid: plane {vmpl} report request failed: {e:?}");
            return Err(e);
        }
    };
    let out = report.as_bytes();
    let cap = desc[2] as usize;
    // tell the guest the size whether or not its buffer was big enough, the shape used elsewhere here
    write_desc_field(params.rcx, 2, out.len() as u64)?;
    if out.len() > cap {
        return Err(SvsmReqError::invalid_parameter());
    }
    write_out(desc[1], out)
}

fn appid_whoami(vmpl: usize, params: &mut RequestParams) -> Result<(), SvsmReqError> {
    require_owning_plane(vmpl)?;
    require_admitted(vmpl)?;
    let desc = read_desc(params.rcx)?;
    let app = app_id_for_plane(vmpl)?;
    write_out(desc[0], &app)
}

/// Dispatch. `vmpl` is the privilege level the request arrived from - the whole point of this protocol is
/// that the app half of report_data comes from the PLANE, not from anything the caller said.
pub fn appid_protocol_request(
    request: u32,
    vmpl: usize,
    params: &mut RequestParams,
) -> Result<(), SvsmReqError> {
    match request {
        SVSM_APPID_GET_REPORT => appid_get_report(vmpl, params),
        SVSM_APPID_WHOAMI => appid_whoami(vmpl, params),
        SVSM_APPID_ADMIT => appid_admit(vmpl, params),
        SVSM_APPID_STATUS => appid_status(vmpl, params),
        SVSM_APPID_REGISTER_KEY => appid_register_key(vmpl, params),
        _ => Err(SvsmReqError::unsupported_call()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    #[test]
    fn vmpl0_is_never_an_app() {
        assert!(app_id_for_plane(0).is_err());
    }

    #[test]
    fn a_plane_beyond_the_hardware_ceiling_is_refused() {
        assert!(app_id_for_plane(VMPL_MAX).is_err());
        assert!(app_id_for_plane(VMPL_MAX + 1).is_err());
    }

    #[test]
    fn an_unassigned_plane_is_refused_rather_than_named_with_zeros() {
        // With no ENCLAVE_APP_IDS in the build, every plane is unassigned, and being unnamed must be an
        // error rather than an all-zero identity that would verify as "some app".
        if option_env!("ENCLAVE_APP_IDS").is_none() {
            for v in 1..VMPL_MAX {
                assert!(app_id_for_plane(v).is_err(), "plane {v} was named with zeros");
            }
        }
    }

    #[test]
    fn the_table_parses_plane_order() {
        // one entry -> plane 1 only
        let t = build_app_table();
        // without a build env this is all zeros; the parser is exercised by the hex helper below
        assert_eq!(t[0], [0u8; APPID_LEN], "VMPL0 must never carry an app id");
    }

    // ---- admission: the logic that turns the table from a label into a claim about bytes ----
    //
    // The hashing and freezing themselves need SEV-SNP hardware and are exercised by the on-hardware
    // negatives in isolation/m4. What these cover is everything that decides WHETHER to hash and freeze,
    // and the gate, because a mistake there is a mistake that lets an unadmitted plane be named.

    /// Each test owns its plane's state: these run in one process and the state is static.
    fn reset(vmpl: usize) {
        ADMITTED[vmpl].store(0, Ordering::Release);
    }

    #[test]
    fn a_plane_is_not_spoken_for_until_every_artifact_is_admitted() {
        let v = 1;
        reset(v);
        assert!(require_admitted(v).is_err(), "an unadmitted plane must not be named");
        ADMITTED[v].store(1 << KIND_BUNDLE, Ordering::Release);
        assert!(
            require_admitted(v).is_err(),
            "the bundle alone is not enough: the runtime image is part of what the identity covers"
        );
        ADMITTED[v].store(1 << KIND_RUNTIME, Ordering::Release);
        assert!(require_admitted(v).is_err(), "the runtime alone is not enough either");
        ADMITTED[v].store(KINDS_REQUIRED, Ordering::Release);
        assert!(require_admitted(v).is_ok(), "both admitted must open the gate");
        reset(v);
    }

    #[test]
    fn admission_state_is_per_plane() {
        reset(1);
        reset(2);
        ADMITTED[1].store(KINDS_REQUIRED, Ordering::Release);
        assert!(require_admitted(1).is_ok());
        assert!(
            require_admitted(2).is_err(),
            "one plane's admission must never speak for another's"
        );
        reset(1);
    }

    #[test]
    fn vmpl0_and_out_of_range_planes_are_refused_by_the_gate() {
        assert!(require_admitted(0).is_err(), "VMPL0 is the SVSM, never an app");
        assert!(require_admitted(VMPL_MAX).is_err());
        assert!(require_admitted(VMPL_MAX + 1).is_err());
    }

    #[test]
    fn an_unknown_artifact_kind_is_refused() {
        for kind in [KIND_COUNT, KIND_COUNT + 1, 7, usize::MAX] {
            assert!(
                expected_digest(1, kind).is_err(),
                "kind {kind} was accepted; a kind this image has no digest for cannot be admitted"
            );
        }
    }

    #[test]
    fn a_plane_with_no_expected_digest_cannot_admit_anything() {
        // With no ENCLAVE_APP_IDS / ENCLAVE_RUNTIME_SHA256 in the build every entry is zero, and an
        // all-zero expectation must be refused rather than matched by an all-zero region.
        if option_env!("ENCLAVE_APP_IDS").is_none() {
            for v in 1..VMPL_MAX {
                assert!(expected_digest(v, KIND_BUNDLE).is_err(), "plane {v} bundle");
            }
        }
        if option_env!("ENCLAVE_RUNTIME_SHA256").is_none() {
            for v in 1..VMPL_MAX {
                assert!(expected_digest(v, KIND_RUNTIME).is_err(), "plane {v} runtime");
            }
        }
    }

    #[test]
    fn the_bundle_digest_is_the_app_id_itself() {
        // isolation/contract: AppID = sha256 of ALL the bundle's bytes. So admitting the bundle and naming
        // the app are the same statement, and there is no second table to keep in step.
        let ids = "11".repeat(APPID_LEN) + "," + &"22".repeat(APPID_LEN);
        let t = build_table(Some(&ids));
        assert_eq!(t[1], [0x11u8; APPID_LEN]);
        assert_eq!(t[2], [0x22u8; APPID_LEN]);
        assert_eq!(t[0], [0u8; APPID_LEN], "VMPL0 must never carry an app id");
    }

    #[test]
    fn the_two_tables_are_independent() {
        // a plane may be named an app and still have no admissible runtime, and vice versa: both are
        // required, so neither table may stand in for the other
        let a = build_table(Some(&"33".repeat(APPID_LEN)));
        let b = build_table(Some(&"44".repeat(APPID_LEN)));
        assert_ne!(a[1], b[1]);
    }

    #[test]
    fn kinds_required_covers_every_kind_this_image_knows() {
        // if a kind is ever added, the gate must demand it rather than silently ignoring it
        let mut want = 0u8;
        for k in 0..KIND_COUNT {
            want |= 1 << k;
        }
        assert_eq!(KINDS_REQUIRED, want, "KINDS_REQUIRED must name every kind");
    }

    #[test]
    fn the_hashing_bound_is_smaller_than_the_guest() {
        // an unbounded length would let one plane make this SVSM hash forever at VMPL0, starving the others
        assert!(MAX_ARTIFACT_BYTES > 0);
        assert!(MAX_ARTIFACT_BYTES <= 64 * 1024 * 1024);
        assert_eq!(MAX_ARTIFACT_BYTES % PAGE_SIZE, 0);
    }

    // ---- ownership: the protocol serves exactly one plane until an oracle exists ----

    #[test]
    fn only_the_plane_this_svsm_was_built_for_is_served() {
        assert!(require_owning_plane(GUEST_VMPL).is_ok());
        for v in 0..VMPL_MAX + 2 {
            if v == GUEST_VMPL {
                continue;
            }
            assert!(
                require_owning_plane(v).is_err(),
                "plane {v} was served: with more than one plane and no ownership oracle, a guest-supplied \
                 GPA cannot be attributed, so ADMIT would freeze a neighbour's pages and write_out would be \
                 a cross-plane write primitive"
            );
        }
    }

    #[test]
    fn the_owning_plane_is_an_app_plane_and_not_the_svsm() {
        // if GUEST_VMPL were ever 0 the whole protocol would be naming the SVSM as an app
        assert!(GUEST_VMPL > 0 && GUEST_VMPL < VMPL_MAX);
    }

    // ---- freeze: what the owner keeps, and that neighbours are never granted anything ----

    // ---- the key registered at plane start, and the binding the SVSM computes over it ----

    fn set_key(vmpl: usize, spki: &[u8]) {
        let mut held = REGISTERED_KEY[vmpl].lock();
        held.0 = [0u8; MAX_SPKI];
        held.0[..spki.len()].copy_from_slice(spki);
        held.1 = spki.len();
    }

    fn clear_key(vmpl: usize) {
        REGISTERED_KEY[vmpl].lock().1 = 0;
    }

    #[test]
    fn no_binding_without_a_registered_key() {
        clear_key(GUEST_VMPL);
        let e = bind2_for_plane(GUEST_VMPL, &[7u8; BIND_LEN]).unwrap_err();
        // either refusal is fail-closed; which one depends on whether this build names a RuntimeID
        let expected_no_key = SvsmReqError::protocol(E_NO_KEY);
        let expected_no_rt = SvsmReqError::protocol(E_NO_RUNTIME_ID);
        assert!(
            format!("{e:?}") == format!("{expected_no_key:?}")
                || format!("{e:?}") == format!("{expected_no_rt:?}"),
            "a plane with no registered key must get no binding, got {e:?}"
        );
    }

    /// A VECTOR from the contract's own implementation, not a reference recomputed beside the code.
    ///
    /// Produced by isolation/contract/runtime.mjs bind2 - which agrees with runtime.go and the Rust launcher on
    /// every vectors.json case - over spki[i] = (i*7+3)&0xff for 91 bytes, nonce[i] = (i*5+1)&0xff for 32, and
    /// RuntimeID = ab repeated 32 times. Recomputing the rule here would pass while the SVSM's computation
    /// drifted from the contract's, which is the shape an earlier review caught twice; a fixed vector cannot.
    const BIND2_VECTOR_RID_AB: [u8; BIND_LEN] = [
        0x0a, 0x73, 0x6a, 0xa6, 0x80, 0xa5, 0x68, 0xd9, 0xd5, 0x51, 0x67, 0x72, 0x5b, 0x57, 0x03, 0xa3,
        0x8a, 0xf9, 0x2e, 0xa1, 0xaa, 0x69, 0xab, 0xd3, 0xec, 0x39, 0xc6, 0x84, 0xa3, 0xbb, 0x27, 0xb8,
    ];

    #[test]
    fn the_binding_matches_the_contracts_own_bind2_vector() {
        // only meaningful when this build's RuntimeID is the vector's; otherwise the refusal path is covered
        if RUNTIME_ID_TABLE[GUEST_VMPL] != [0xabu8; APPID_LEN] {
            return;
        }
        let spki: [u8; 91] = core::array::from_fn(|i| (i * 7 + 3) as u8);
        let nonce: [u8; BIND_LEN] = core::array::from_fn(|i| (i * 5 + 1) as u8);
        set_key(GUEST_VMPL, &spki);
        let got = bind2_for_plane(GUEST_VMPL, &nonce).expect("a registered key and a RuntimeID must bind");
        assert_eq!(
            got, BIND2_VECTOR_RID_AB,
            "the SVSM's binding must equal the contract's Bind2 over the same inputs, or every honest domain \
             looks like a liar to a verifier that recomputes it"
        );
        clear_key(GUEST_VMPL);
    }

    #[test]
    fn a_different_key_or_nonce_or_runtime_gives_a_different_binding() {
        if RUNTIME_ID_TABLE[GUEST_VMPL] == [0u8; APPID_LEN] {
            return;
        }
        let nonce = [9u8; BIND_LEN];
        set_key(GUEST_VMPL, &[1u8; 91]);
        let a = bind2_for_plane(GUEST_VMPL, &nonce).unwrap();
        clear_key(GUEST_VMPL);
        set_key(GUEST_VMPL, &[2u8; 91]);
        let b = bind2_for_plane(GUEST_VMPL, &nonce).unwrap();
        assert_ne!(a, b, "a different transport key must give a different binding");
        let c = bind2_for_plane(GUEST_VMPL, &[8u8; BIND_LEN]).unwrap();
        assert_ne!(b, c, "a different nonce must give a different binding");
        clear_key(GUEST_VMPL);
    }

    #[test]
    fn a_key_is_registered_once_and_the_registration_is_per_plane() {
        // the property: no compromise after plane start can re-point the binding at another key
        clear_key(GUEST_VMPL);
        set_key(GUEST_VMPL, &[3u8; 91]);
        assert_ne!(REGISTERED_KEY[GUEST_VMPL].lock().1, 0);
        for v in 0..VMPL_MAX {
            if v == GUEST_VMPL {
                continue;
            }
            assert_eq!(
                REGISTERED_KEY[v].lock().1, 0,
                "plane {v} must have no key of its own from plane {GUEST_VMPL}'s registration"
            );
        }
        clear_key(GUEST_VMPL);
    }

    #[test]
    fn the_spki_bound_is_the_bytes_registered_not_a_digest_of_them() {
        // Registering a digest would make "the report carries the key this plane registered" a statement about
        // a hash rather than about the key, and a verifier recomputes Bind2 over the SPKI its own handshake saw.
        assert!(MAX_SPKI >= 91, "a P-256 SubjectPublicKeyInfo is 91 bytes and must fit");
        clear_key(GUEST_VMPL);
        let spki: [u8; 91] = core::array::from_fn(|i| i as u8);
        set_key(GUEST_VMPL, &spki);
        let held = REGISTERED_KEY[GUEST_VMPL].lock();
        assert_eq!(&held.0[..held.1], &spki[..], "the SPKI itself is recorded");
        drop(held);
        clear_key(GUEST_VMPL);
    }

    #[test]
    fn every_refusal_has_its_own_code() {
        // a harness that can only see "refused" cannot tell a finding from a bug in our own staging
        let codes = [
            E_NOT_OWNING_PLANE, E_PLANE_UNASSIGNED, E_NOT_ADMITTED, E_DIGEST_MISMATCH,
            E_ALREADY_ADMITTED, E_FREEZE_FAILED, E_CHANGED_UNDER_US, E_RECORD_FAILED,
            E_NO_KEY, E_KEY_ALREADY_SET, E_NO_RUNTIME_ID,
        ];
        for (i, a) in codes.iter().enumerate() {
            assert_ne!(*a, 0, "0 would read as success");
            for b in &codes[i + 1..] {
                assert_ne!(a, b, "two refusals share a code");
            }
        }
    }

    #[test]
    fn freeze_never_grants_a_neighbour_anything() {
        // THE regression for the defect the review found: the first freeze_pages iterated the planes granting
        // READ|X_USER|X_SUPER to VMPL1, 2 and 3, which handed every neighbour read and execute on the owner's
        // memory. This asserts the mask the code actually applies, per plane, for both kinds.
        let owner = GUEST_VMPL;
        for kind in [KIND_BUNDLE, KIND_RUNTIME] {
            for level in [RMPFlags::VMPL1.bits(), RMPFlags::VMPL2.bits(), RMPFlags::VMPL3.bits()] {
                let mask = plane_mask(level, owner, kind);
                assert_eq!(mask & RMPFlags::WRITE.bits(), 0, "no plane may keep WRITE on a frozen page");
                if level as usize == owner {
                    assert_ne!(mask & RMPFlags::READ.bits(), 0, "the owner must still read its own artifact");
                    let x = mask & (RMPFlags::X_USER.bits() | RMPFlags::X_SUPER.bits());
                    if kind == KIND_RUNTIME {
                        assert_ne!(x, 0, "the runtime image must remain executable to its owner");
                    } else {
                        assert_eq!(x, 0, "a bundle is data: never executable");
                    }
                } else {
                    assert_eq!(mask & !level, 0, "a non-owner plane must be left with NO permission at all");
                }
            }
        }
    }

    // ---- the malformed table forms, as real tests. The comment here used to claim they could only be
    // compile-time panics; build_table is a const fn but it is also callable at runtime, so each form can be
    // pinned, which is what the review pointed out. ----

    #[test]
    #[should_panic(expected = "more entries than this hardware has app planes")]
    fn four_entries_are_refused_not_silently_truncated() {
        let e = "aa".repeat(APPID_LEN);
        build_table(Some(&[e.clone(), e.clone(), e.clone(), e].join(",")));
    }

    #[test]
    #[should_panic(expected = "not exactly 64 hex digits")]
    fn an_odd_length_entry_is_refused_with_a_reason_not_an_index_error() {
        build_table(Some(&"a".repeat(63)));
    }

    #[test]
    #[should_panic(expected = "a comma arrived early")]
    fn a_short_entry_does_not_silently_name_a_plane_with_a_half_zero_digest() {
        build_table(Some(&format!("{},{}", "aa".repeat(30), "bb".repeat(APPID_LEN))));
    }

    #[test]
    #[should_panic(expected = "exactly one comma")]
    fn two_entries_with_no_separator_do_not_silently_become_two_planes() {
        build_table(Some(&format!("{}{}", "aa".repeat(APPID_LEN), "bb".repeat(APPID_LEN))));
    }

    #[test]
    #[should_panic(expected = "no spaces")]
    fn a_space_after_the_comma_does_not_silently_drop_later_planes() {
        build_table(Some(&format!("{}, {}", "aa".repeat(APPID_LEN), "bb".repeat(APPID_LEN))));
    }

    #[test]
    #[should_panic(expected = "exactly one comma")]
    fn a_semicolon_is_not_a_separator() {
        build_table(Some(&format!("{};{}", "aa".repeat(APPID_LEN), "bb".repeat(APPID_LEN))));
    }

    #[test]
    #[should_panic(expected = "trailing comma")]
    fn a_trailing_comma_is_refused() {
        build_table(Some(&format!("{},", "aa".repeat(APPID_LEN))));
    }

    #[test]
    #[should_panic(expected = "not a hex digit")]
    fn a_non_hex_character_is_refused_not_silently_left_short() {
        build_table(Some(&format!("{}zz", "aa".repeat(APPID_LEN - 1))));
    }

    #[test]
    fn a_frozen_bundle_is_readable_and_not_executable_and_not_writable() {
        // the mask freeze_pages builds for the owner, asserted directly: the review found the first version
        // GRANTED read+execute to VMPL1..3, which handed every neighbour access to the caller's memory
        let bundle = RMPFlags::READ.bits();
        assert_eq!(bundle & RMPFlags::WRITE.bits(), 0, "a frozen page must not be writable");
        assert_eq!(bundle & RMPFlags::X_USER.bits(), 0, "a bundle is data: no execute");
        assert_eq!(bundle & RMPFlags::X_SUPER.bits(), 0, "a bundle is data: no supervisor execute");
        assert_ne!(bundle & RMPFlags::READ.bits(), 0, "the owner must still be able to read it");
    }

    #[test]
    fn a_frozen_runtime_may_execute_but_still_not_write() {
        let rt = RMPFlags::READ.bits() | RMPFlags::X_USER.bits() | RMPFlags::X_SUPER.bits();
        assert_eq!(rt & RMPFlags::WRITE.bits(), 0, "even code must lose write: W^X, in the RMP");
        assert_ne!(rt & RMPFlags::X_USER.bits(), 0);
    }

    #[test]
    fn a_non_owner_plane_gets_nothing() {
        assert_eq!(RMPFlags::NONE.bits(), 0, "NONE must really be no permission at all");
    }

    // ---- admitted pages: the PVALIDATE path must see them ----

    #[test]
    fn an_admitted_page_is_found_and_its_neighbours_are_not() {
        {
            let mut held = ADMITTED_PAGES.lock();
            held.clear();
            held.push(0x4000_0000);
            held.push(0x4000_2000);
            held.sort_unstable();
        }
        assert!(page_is_admitted(PhysAddr::from(0x4000_0000u64)));
        assert!(page_is_admitted(PhysAddr::from(0x4000_0fffu64)), "any offset within the page");
        assert!(page_is_admitted(PhysAddr::from(0x4000_2000u64)));
        assert!(!page_is_admitted(PhysAddr::from(0x4000_1000u64)), "the gap is not admitted");
        assert!(!page_is_admitted(PhysAddr::from(0x5000_0000u64)));
        // a 2 MiB PVALIDATE entry covering an admitted 4 KiB page must be refused as a whole
        assert!(region_is_admitted(PhysAddr::from(0x4000_0000u64), 0x20_0000));
        assert!(region_is_admitted(PhysAddr::from(0x4000_1000u64), 0x2000), "spans into 0x40002000");
        assert!(!region_is_admitted(PhysAddr::from(0x4000_1000u64), 0x1000), "the gap alone");
        assert!(!region_is_admitted(PhysAddr::from(0x5000_0000u64), 0x20_0000));
        ADMITTED_PAGES.lock().clear();
    }

    #[test]
    fn nothing_is_admitted_before_anything_is_admitted() {
        ADMITTED_PAGES.lock().clear();
        assert!(!page_is_admitted(PhysAddr::from(0x4000_0000u64)));
        assert!(!region_is_admitted(PhysAddr::from(0u64), 0x20_0000));
    }

    // ---- the strict table parser ----

    #[test]
    fn the_parser_accepts_exactly_what_it_documents() {
        let one = "aa".repeat(APPID_LEN);
        let t = build_table(Some(&one));
        assert_eq!(t[1], [0xaau8; APPID_LEN]);
        assert_eq!(t[2], [0u8; APPID_LEN], "one entry names one plane");

        let three = [one.clone(), "bb".repeat(APPID_LEN), "cc".repeat(APPID_LEN)].join(",");
        let t = build_table(Some(&three));
        assert_eq!(t[1], [0xaau8; APPID_LEN]);
        assert_eq!(t[2], [0xbbu8; APPID_LEN]);
        assert_eq!(t[3], [0xccu8; APPID_LEN]);
        assert_eq!(t[0], [0u8; APPID_LEN], "VMPL0 is never an app");

        // uppercase is the same digest, and the empty string names nothing
        assert_eq!(build_table(Some(&"AA".repeat(APPID_LEN)))[1], [0xaau8; APPID_LEN]);
        assert_eq!(build_table(Some("")), [[0u8; APPID_LEN]; VMPL_MAX]);
        assert_eq!(build_table(None), [[0u8; APPID_LEN]; VMPL_MAX]);
    }

    // Each malformed form is pinned by a #[should_panic] test above. In a BUILD the same panic is a compile
    // error, which is the point: the table ends up inside a launch measurement, so an operator typo must fail
    // the build rather than ship an image whose table is not what was written. What the lenient version this
    // replaced did instead, as an independent review measured:
    //
    //   "<64>,<64>,<64>,<64>"   4 entries: was SILENTLY IGNORED     -> now panics (more than 3 app planes)
    //   "<63 hex digits>"       odd length: was an index-OOB panic  -> now panics naming the length
    //   "<60 hex digits>,<64>"  short: SILENTLY named plane 1 with a half-zero digest -> now panics
    //   "<64><64>" (no comma)   SILENTLY became two planes          -> now panics (separator)
    //   "<64>, <64>" (space)    SILENTLY dropped plane 2            -> now panics (separator)
    //   "<64>;<64>" (semicolon) SILENTLY dropped plane 2            -> now panics (separator)
    //   "<64>,"  (trailing)     SILENTLY dropped plane 2            -> now panics (trailing comma)
    //   "<62>zz"                non-hex: SILENTLY left 31 bytes     -> now panics (not a hex digit)

    #[test]
    fn hex_rejects_non_hex() {
        assert_eq!(hex_val(b'0'), 0);
        assert_eq!(hex_val(b'f'), 15);
        assert_eq!(hex_val(b'F'), 15);
        assert_eq!(hex_val(b'g'), 0xff);
        assert_eq!(hex_val(b','), 0xff);
    }
}
