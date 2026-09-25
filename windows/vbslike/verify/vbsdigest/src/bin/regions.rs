// regions: for each needle (a file slice), find the IGVM PageData directives whose data contains it, and print
// whether those pages are MEASURED (not unmeasured, not shared). Usage: regions <igvm> <label>=<file>:<hexoff>:<len> ...
use igvm::{IgvmDirectiveHeader, IgvmFile, IsolationType};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let f = IgvmFile::new_from_binary(&std::fs::read(&a[1]).unwrap(), Some(IsolationType::Vbs)).unwrap();
    for spec in &a[2..] {
        let (label, rest) = spec.split_once('=').unwrap();
        let mut p = rest.rsplitn(3, ':');
        let len: usize = p.next().unwrap().parse().unwrap();
        let off = usize::from_str_radix(p.next().unwrap().trim_start_matches("0x"), 16).unwrap();
        let file = p.next().unwrap();
        let src = std::fs::read(file).unwrap();
        let needle = &src[off..off + len];
        let mut hits = 0;
        for d in f.directives() {
            if let IgvmDirectiveHeader::PageData { gpa, flags, data, .. } = d {
                if data.len() >= len && data.windows(len).any(|w| w == needle) {
                    hits += 1;
                    println!("{label}: gpa 0x{gpa:x} measured={} shared={}", !flags.unmeasured(), flags.shared());
                }
            }
        }
        if hits == 0 { println!("{label}: NOT FOUND in any page (sample may straddle a page boundary)"); }
    }
}
