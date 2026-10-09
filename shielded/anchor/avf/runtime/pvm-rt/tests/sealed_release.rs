// A deployment's sealed secrets, opened in the VM (src/sealed_release.rs; PVM-CPU.md "Secrets"), against vectors made by the
// relay's own code (relay/secrets-release.mjs sealRelease + signResponse on main) with a fixed ephemeral key, IV and release
// key -- synthetic values, no real key: the VM opens exactly what the relay seals, refuses what the relay did not sign, and
// resolves $NAME in the config exactly as the platform runner does.
use pvm_rt::sealed_release::{open, seal_keypair, substitute};

fn h<const N: usize>(s: &str) -> [u8; N] {
    let v: Vec<u8> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect();
    v.try_into().unwrap()
}
fn hv(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
const SEED: &str = "a07db3ef1203e505609993e7cc66269a79db7fccd38fc982ea0d917f76973ac9"; // gitleaks:allow -- a synthetic test seed (sha256 of a label), no real key
const ID: &str = "0xe8482567a0ab1698462e0909e195eed16ad283b732b364b0d7d2bbf2cacf1573";
const TICKET: &str = "6a8407bd41f789d62df552add19d463998d4644334865cf219ddada47ddba504";
const SEAL_KEY: &str = "f42568ff7d458c5712cde86484022df763b0f9c505194b5e491a5b741b697c75";
const RELAY_PUB: &str = "a2575cf089f02f612cc295476fd34bd9b28d56484f2f89ec508e5606b6cefbce"; // gitleaks:allow -- a public key
const SIG: &str = "0eb8e872b4177612fcbf3fe11524463358f4d5eb587ccb4489ca5faa2e1237bb68bd0a88e163fd15e7654253d1e40facb9dfad515f0aca4c9576f1b227a0fd0a";
const SEALED: &str = "ed5627cd5403c9c88c8ea865a4a536b22fbc68e466c95f75f733e1a744dd561457f0dc5cb14236fc2fca8cead1b3eaa233288a12714cd6c6eb4cd814ed12d081c67069d42742c6c4c133e6e36997730d4e75604ce499d23868485d302cb70cc91327ed7c38b7757076f48f39104d39a851d37c1768713a25673fe1b01f13b4a9adba36392be16ac70d42deffd5fec68b9909fb5ed8893cae7cb2fa08385f0dd4da8e26275f1837ecfdc1ba0f1b2474b06d33176ee25c20dd5704ffcf3642d7d64352408999fa0f6a4e6b6581b661afcb6b97ae493c8aa6250a4b03e3a11c7c58171adbe31cbefe2fa8bd2e4f27b57da539cf9b07e57bf1d11cc3b4d51603249852eeec7c81d12b86f93c8438cdd35901";
const CONFIG: &str = "{\"endpoint\":\"$S3_ENDPOINT\",\"nested\":[\"${MCP_ADAPTER_API_KEY}\",\"price $$5\",\"$NOT_A_SECRET\",\"x$EMPTY\"],\"n\":3.5,\"k\":{\"$S3_ENDPOINT\":\"$S3_ENDPOINT/b\"}}";
const CONFIG_RESOLVED: &str = "{\"endpoint\":\"https://s3.example\",\"nested\":[\"k3y\\\"with\\\\quote\",\"price $5\",\"$NOT_A_SECRET\",\"x\"],\"n\":3.5,\"k\":{\"$S3_ENDPOINT\":\"https://s3.example/b\"}}";

fn release() -> Vec<u8> {
    [hv(TICKET), hv(SIG), hv(SEALED)].concat()
}
fn id() -> [u8; 32] {
    h(&ID[2..])
}

#[test]
fn the_vm_opens_what_the_relay_sealed() {
    assert_eq!(seal_keypair(&h(SEED)).1, h::<32>(SEAL_KEY), "the seal key the payload states is the one the relay sealed to");
    let s = open(&release(), &h(SEED), &id(), &[h(RELAY_PUB)]).unwrap();
    assert_eq!(s, vec![
        ("MCP_ADAPTER_API_KEY".to_string(), "k3y\"with\\quote".to_string()),
        ("S3_ENDPOINT".to_string(), "https://s3.example".to_string()),
        ("EMPTY".to_string(), String::new()),
    ]);
}

#[test]
fn a_release_the_relay_did_not_sign_or_for_another_deployment_is_refused() {
    let other_key = [7u8; 32];
    assert!(open(&release(), &h(SEED), &id(), &[other_key]).unwrap_err().contains("not signed by a release key this build pins"));
    // one byte of the sealed body changed: the signature covers it
    let mut r = release();
    let n = r.len();
    r[n - 1] ^= 1;
    assert!(open(&r, &h(SEED), &id(), &[h(RELAY_PUB)]).unwrap_err().contains("not signed"));
    // another deployment's id: the signature is over the id too
    let mut other = id();
    other[0] ^= 1;
    assert!(open(&release(), &h(SEED), &other, &[h(RELAY_PUB)]).is_err());
    // another VM (another seal seed): the digest names the seal key, so not even the signature holds
    let mut seed = h::<32>(SEED);
    seed[5] ^= 1; // (not byte 0's low bits: X25519 clamping clears them, so that "other" seed is the same key)
    assert!(open(&release(), &seed, &id(), &[h(RELAY_PUB)]).is_err());
    assert!(open(&release()[..100], &h(SEED), &id(), &[h(RELAY_PUB)]).unwrap_err().contains("too short"));
}

#[test]
fn secrets_resolve_in_the_config_as_the_platform_runner_resolves_them() {
    let s = open(&release(), &h(SEED), &id(), &[h(RELAY_PUB)]).unwrap();
    let got = substitute(CONFIG, &s);
    let a = pvm_rt::waf::serde_like::parse(&got).unwrap();
    let b = pvm_rt::waf::serde_like::parse(CONFIG_RESOLVED).unwrap();
    assert_eq!(a, b, "the same JSON as JSON.stringify(walk(JSON.parse(config))): {got}");
    assert_eq!(substitute("not json $S3_ENDPOINT", &s), "not json $S3_ENDPOINT");
    assert_eq!(substitute(CONFIG, &[]), CONFIG);
}
