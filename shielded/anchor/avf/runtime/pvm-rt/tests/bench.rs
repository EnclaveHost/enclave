// The tier's compute measurement (src/lib.rs bench / pvmrt_bench) on the host, under the same Pulley interpreter the pVM
// runs: conformance/flops-probe (bundles/flops-probe.wasm) does an exactly counted number of f32 multiply-adds; N instances
// run at once from a barrier, and the work over the wall time is the figure the VM reports.
use pvm_rt::{bench, MAX_BENCH_INSTANCES};
use std::time::Duration;

fn probe() -> (Vec<u8>, [u8; 32]) {
    let b = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/bundles/flops-probe.wasm")).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&b).into();
    (b, d)
}
fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}
fn flops(out: &[u8]) -> u64 {
    let s = String::from_utf8_lossy(out);
    s.split_whitespace().find_map(|w| w.strip_prefix("flops=")).and_then(|n| n.parse().ok()).unwrap()
}

#[test]
fn every_instance_does_the_same_exact_work_and_the_wall_time_covers_them_all() {
    let (b, d) = probe();
    let o = bench(&b, &d, &args(&["simd", "20000", "7"]), 3, 64 << 20, Duration::from_secs(120)).unwrap();
    assert_eq!(o.exit_codes, vec![0, 0, 0]);
    let first = String::from_utf8_lossy(&o.stdout[0]).to_string();
    assert!(first.starts_with("flops=2560000 kernel=simd steps=20000 sum="), "{first}");
    assert!(o.stdout.iter().all(|s| String::from_utf8_lossy(s) == first), "the same deterministic answer from every instance");
    assert_eq!(flops(&o.stdout[0]), 20000 * 2 * 4 * 16);
    assert!(o.wall_ms > 0);
    let gflops = 3.0 * flops(&o.stdout[0]) as f64 / o.wall_ms as f64 / 1e6;
    eprintln!("host Pulley: 3 instances, {} ms wall, {:.3} GFLOPS (compile {} ms)", o.wall_ms, gflops, o.compile_ms);
}

#[test]
fn more_work_takes_proportionally_longer() {
    // nothing is folded away: 4x the steps takes clearly longer (bounded loosely, the host is shared)
    let (b, d) = probe();
    let t = |n: &str| bench(&b, &d, &args(&["simd", n, "7"]), 1, 64 << 20, Duration::from_secs(120)).unwrap().wall_ms;
    let (small, big) = (t("20000"), t("80000"));
    assert!(big as f64 > small as f64 * 2.5, "{small} ms vs {big} ms");
}

#[test]
fn refusals_wrong_digest_bad_instance_counts_a_failing_instance_and_the_deadline() {
    let (b, d) = probe();
    let mut bad = d;
    bad[0] ^= 1;
    assert!(format!("{:#}", bench(&b, &bad, &args(&["simd", "10", "7"]), 1, 64 << 20, Duration::from_secs(5)).err().unwrap()).contains("refusing to compile"));
    for n in [0, MAX_BENCH_INSTANCES + 1] {
        assert!(bench(&b, &d, &args(&["simd", "10", "7"]), n, 64 << 20, Duration::from_secs(5)).is_err());
    }
    let o = bench(&b, &d, &args(&["nonsense"]), 2, 64 << 20, Duration::from_secs(5)).unwrap();
    assert_eq!(o.exit_codes, vec![1, 1], "a usage error fails every instance (wasi:cli exit carries success or failure)");
    // a run past its deadline is stopped, every instance
    assert!(bench(&b, &d, &args(&["simd", "1000000000000", "7"]), 2, 64 << 20, Duration::from_millis(300)).is_err());
}
