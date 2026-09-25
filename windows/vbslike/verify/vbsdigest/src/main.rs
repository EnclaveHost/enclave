// vbsdigest: the VBS launch digest of an IGVM file, computed with the pinned igvm crate (b7e717d),
// independently of igvmfilegen's own report. Usage: vbsdigest <file.bin> [...]
use igvm::{IgvmFile, IsolationType};
use igvm_defs::IgvmPlatformType;
fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read");
        let f = IgvmFile::new_from_binary(&bytes, Some(IsolationType::Vbs)).expect("parse as a VBS IGVM");
        let vbs: Vec<_> = f.platforms().iter().filter_map(|p| match p {
            igvm::IgvmPlatformHeader::SupportedPlatform(h) if h.platform_type == IgvmPlatformType::VSM_ISOLATION => Some(h.compatibility_mask),
            _ => None }).collect();
        assert_eq!(vbs.len(), 1, "exactly one VSM_ISOLATION platform expected");
        let d = igvm::measurement::generate_vbs_measurement(f.directives(), vbs[0]).expect("measure");
        let hex: String = d.iter().map(|b| format!("{:02X}", b)).collect();
        println!("{hex}  {path}");
    }
}
