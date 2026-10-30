//! flops-probe <kernel> <steps> <seed> -- the pVM CPU tier's GFLOPS measurement (PVM-CPU.md, "Capacity").
//!
//! A fixed, exactly counted amount of floating-point work, run by the SAME runtime apps run under (pvm-rt: Pulley, no JIT),
//! so the figure is what a deployment can actually get, not the cores' native peak.
//!   kernel "scalar": 16 independent f32 chains, x = x * m + c, per step -> 32 flops/step
//!   kernel "simd":   16 independent f32x4 chains (wasm simd128), the same per lane -> 128 flops/step
//! m and c come from `seed`, so nothing is computed at build time. It prints one line:
//!   flops=<exact count> kernel=<k> steps=<n> sum=<the chains' sum, 9 decimals>
//! The caller times the run (pvm-rt's run_ms / bench wall time); this program never reads a clock.
use std::process::exit;

const CHAINS: usize = 16;

fn scalar(steps: u64, m: f32, c: f32) -> f32 {
    let mut x = [0f32; CHAINS];
    for (i, v) in x.iter_mut().enumerate() {
        *v = (i as f32) * 0.01;
    }
    for _ in 0..steps {
        for v in x.iter_mut() {
            *v = *v * m + c;
        }
    }
    x.iter().sum()
}

#[cfg(target_arch = "wasm32")]
fn simd(steps: u64, m: f32, c: f32) -> f32 {
    use core::arch::wasm32::*;
    let (vm, vc) = (f32x4_splat(m), f32x4_splat(c));
    let mut x = [f32x4_splat(0.0); CHAINS];
    for (i, v) in x.iter_mut().enumerate() {
        *v = f32x4(i as f32 * 0.01, i as f32 * 0.02, i as f32 * 0.03, i as f32 * 0.04);
    }
    for _ in 0..steps {
        for v in x.iter_mut() {
            *v = f32x4_add(f32x4_mul(*v, vm), vc);
        }
    }
    let mut s = 0f32;
    for v in x {
        s += f32x4_extract_lane::<0>(v) + f32x4_extract_lane::<1>(v) + f32x4_extract_lane::<2>(v) + f32x4_extract_lane::<3>(v);
    }
    s
}
#[cfg(not(target_arch = "wasm32"))]
fn simd(steps: u64, m: f32, c: f32) -> f32 {
    // the same arithmetic lane by lane (a host build, for the reference value only)
    let mut s = 0f32;
    let mut x = [[0f32; 4]; CHAINS];
    for (i, v) in x.iter_mut().enumerate() {
        *v = [i as f32 * 0.01, i as f32 * 0.02, i as f32 * 0.03, i as f32 * 0.04];
    }
    for _ in 0..steps {
        for v in x.iter_mut() {
            for l in v.iter_mut() {
                *l = *l * m + c;
            }
        }
    }
    for v in x {
        s += v[0] + v[1] + v[2] + v[3];
    }
    s
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (kernel, steps, seed) = match (a.get(1), a.get(2).and_then(|s| s.parse::<u64>().ok()), a.get(3).and_then(|s| s.parse::<u32>().ok())) {
        (Some(k), Some(n), Some(s)) if (k == "scalar" || k == "simd") && n > 0 && n <= 1 << 40 => (k.clone(), n, s),
        _ => {
            eprintln!("usage: flops-probe scalar|simd <steps 1..2^40> <seed u32>");
            exit(2)
        }
    };
    // m in (0.99, 1), c small: every chain converges to c / (1 - m), so no value overflows or goes denormal
    let m = 0.99 + (seed % 1000) as f32 * 0.00000999;
    let c = 0.001 + (seed % 7) as f32 * 0.0001;
    let (sum, per_step) = if kernel == "simd" { (simd(steps, m, c), 2 * 4 * CHAINS as u64) } else { (scalar(steps, m, c), 2 * CHAINS as u64) };
    println!("flops={} kernel={} steps={} sum={:.9}", steps * per_step, kernel, steps, sum);
}
