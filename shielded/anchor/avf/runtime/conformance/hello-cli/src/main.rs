// The portable runtime's conformance component (shielded/anchor/avf/runtime, PVM-CPU.md): a wasi:cli command whose output
// is fully determined by its arguments, so every domain (Linux Cranelift, Linux Pulley, the Pixel pVM's Pulley) must print
// exactly the same bytes.
//   hello                -> banner, a deterministic computation, exit 0
//   hello alloc <MiB>    -> tries to hold that much linear memory (the runtime's memory limit must stop it)
//   hello spin           -> never returns (the runtime's deadline must stop it)
//   hello exit <n>       -> exits with n
fn fnv1a(data: &[u8]) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("alloc") => {
            let mib: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(64);
            let mut v: Vec<Vec<u8>> = Vec::new();
            for i in 0..mib {
                v.push(vec![i as u8; 1 << 20]);
            }
            println!("allocated {} MiB", v.len());
        }
        Some("spin") => {
            let mut x = 0u64;
            loop {
                x = std::hint::black_box(x.wrapping_add(1));
            }
        }
        Some("exit") => std::process::exit(args.get(1).and_then(|s| s.parse().ok()).unwrap_or(3)),
        _ => {
            println!("pvm-rt conformance v1");
            println!("args {}", args.len());
            // deterministic work: the first 10000 primes, their sum and a hash of their decimal text
            let (mut primes, mut n) = (Vec::with_capacity(10000), 2u64);
            while primes.len() < 10000 {
                if primes
                    .iter()
                    .take_while(|&&p| p * p <= n)
                    .all(|&p| n % p != 0)
                {
                    primes.push(n);
                }
                n += 1;
            }
            let text: String = primes
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(",");
            println!(
                "primes {} sum {} fnv1a {:016x}",
                primes.len(),
                primes.iter().sum::<u64>(),
                fnv1a(text.as_bytes())
            );
        }
    }
}
