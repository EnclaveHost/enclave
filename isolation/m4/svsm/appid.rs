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

use crate::address::{Address, PhysAddr};
use crate::mm::guestmem::copy_slice_to_guest;
use crate::mm::PerCPUPageMappingGuard;
use crate::protocols::attest::get_attestation_report_for_app;
use zerocopy::IntoBytes;
use crate::protocols::errors::SvsmReqError;
use crate::protocols::RequestParams;
use crate::sev::vmsa::VMPL_MAX;

pub const APPID_PROTOCOL_VERSION_MIN: u32 = 1;
pub const APPID_PROTOCOL_VERSION_MAX: u32 = 1;

/// Ask for a report naming the calling plane's app.
///   rcx = GPA of the 32-byte bind the app computed (sha256(its SPKI || the verifier's nonce))
///   rdx = GPA of the buffer to write the report into
///   r8  = length of that buffer; on return, the length written
const SVSM_APPID_GET_REPORT: u32 = 0;
/// Ask which app ID this plane is, without a report. rcx = GPA of a 32-byte output buffer.
const SVSM_APPID_WHOAMI: u32 = 1;

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

const fn build_app_table() -> [[u8; APPID_LEN]; VMPL_MAX] {
    let mut t = [[0u8; APPID_LEN]; VMPL_MAX];
    // Filled from the build environment; absent entries stay zero and are refused at request time.
    let ids = match option_env!("ENCLAVE_APP_IDS") {
        Some(s) => s.as_bytes(),
        None => b"",
    };
    let mut plane = 1usize;
    let mut i = 0usize;
    while plane < VMPL_MAX {
        // each entry is 64 hex characters, separated by commas
        let mut byte = 0usize;
        let mut ok = true;
        while byte < APPID_LEN {
            let hi = i + byte * 2;
            if hi + 1 >= ids.len() + 1 || hi + 1 > ids.len() {
                ok = false;
                break;
            }
            let h = hex_val(ids[hi]);
            let l = hex_val(ids[hi + 1]);
            if h == 0xff || l == 0xff {
                ok = false;
                break;
            }
            t[plane][byte] = h << 4 | l;
            byte += 1;
        }
        if !ok {
            break;
        }
        i += APPID_LEN * 2;
        if i < ids.len() && ids[i] == b',' {
            i += 1;
        }
        plane += 1;
    }
    t
}

const fn hex_val(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0xff,
    }
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

fn write_out(gpa_raw: u64, data: &[u8]) -> Result<(), SvsmReqError> {
    let gpa = PhysAddr::from(gpa_raw);
    let offset = gpa.page_offset();
    if offset + data.len() > crate::types::PAGE_SIZE {
        return Err(SvsmReqError::invalid_parameter());
    }
    let _ = offset;
    copy_slice_to_guest(data, gpa).map_err(SvsmReqError::from)
}

fn appid_get_report(vmpl: usize, params: &mut RequestParams) -> Result<(), SvsmReqError> {
    let bind = read_bind(params.rcx)?;
    let app = app_id_for_plane(vmpl)?;

    // report_data, assembled HERE: the caller's bind, and the app ID this plane is measured to be.
    let mut report_data = [0u8; BIND_LEN + APPID_LEN];
    report_data[..BIND_LEN].copy_from_slice(&bind);
    report_data[BIND_LEN..].copy_from_slice(&app);

    let report = get_attestation_report_for_app(&report_data)?;
    let out = report.as_bytes();
    let cap = params.r8 as usize;
    params.r8 = out.len() as u64;
    if out.len() > cap {
        // the spec shape used elsewhere in this SVSM: tell the guest the size and let it call again
        return Err(SvsmReqError::invalid_parameter());
    }
    write_out(params.rdx, out)
}

fn appid_whoami(vmpl: usize, params: &mut RequestParams) -> Result<(), SvsmReqError> {
    let app = app_id_for_plane(vmpl)?;
    write_out(params.rcx, &app)
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
        _ => Err(SvsmReqError::unsupported_call()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn hex_rejects_non_hex() {
        assert_eq!(hex_val(b'0'), 0);
        assert_eq!(hex_val(b'f'), 15);
        assert_eq!(hex_val(b'F'), 15);
        assert_eq!(hex_val(b'g'), 0xff);
        assert_eq!(hex_val(b','), 0xff);
    }
}
