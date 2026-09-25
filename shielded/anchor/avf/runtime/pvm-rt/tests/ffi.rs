// The C ABI's boundary checks (src/lib.rs, pvmrt_identity / pvmrt_run_cli): every invalid pointer or length is refused
// BEFORE it is dereferenced or offset, so these calls exercise the refusals without undefined behaviour -- each invalid
// pointer here is either null or never read past what the call checks first. One valid call proves the same boundary runs a
// component end to end.
use std::ffi::{c_char, c_int, CStr};
use std::ptr::{null, null_mut};
use std::sync::Mutex;

// Each test has its own collector: the tests run in parallel, and a refused call must be shown to emit nothing.
static OUT: Mutex<Vec<(c_int, Vec<u8>)>> = Mutex::new(Vec::new());
static REFUSED_OUT: Mutex<Vec<(c_int, Vec<u8>)>> = Mutex::new(Vec::new());
extern "C" fn collect_refused(stream: c_int, _p: *const u8, n: usize) {
    REFUSED_OUT.lock().unwrap().push((stream, vec![0; n]));
}
extern "C" fn collect(stream: c_int, p: *const u8, n: usize) {
    let b = if n == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(p, n) }.to_vec()
    };
    OUT.lock().unwrap().push((stream, b));
}

fn bundle() -> (Vec<u8>, [u8; 32]) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance");
    let b = std::fs::read(dir.join("bundles/hello-v1.wasm")).unwrap();
    let v = std::fs::read_to_string(dir.join("vectors.json")).unwrap();
    let i = v.find("\"bundle_sha256\": \"").unwrap() + 18;
    let mut want = [0u8; 32];
    for k in 0..32 {
        want[k] = u8::from_str_radix(&v[i + 2 * k..i + 2 * k + 2], 16).unwrap();
    }
    (b, want)
}

/// Calls pvmrt_run_cli with the given overrides; returns (rc, err).
#[allow(clippy::too_many_arguments)]
fn call(
    bundle: *const u8,
    len: usize,
    sha: *const u8,
    argv: *const *const c_char,
    argc: c_int,
    mem: u64,
    deadline: u64,
    emit: pvm_rt::EmitFn,
) -> (c_int, String) {
    let mut err = [0 as c_char; 512];
    let mut code: c_int = -99;
    let rc = pvm_rt::pvmrt_run_cli(
        bundle,
        len,
        sha,
        argv,
        argc,
        mem,
        deadline,
        emit,
        &mut code,
        null_mut(),
        null_mut(),
        err.as_mut_ptr(),
        err.len(),
    );
    (
        rc,
        unsafe { CStr::from_ptr(err.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
    )
}

#[test]
fn identity_refuses_a_null_or_empty_buffer_and_reports_truncation() {
    assert_eq!(pvm_rt::pvmrt_identity(null_mut(), 512), -1, "null out");
    let mut one = [0x55 as c_char; 1];
    assert_eq!(pvm_rt::pvmrt_identity(one.as_mut_ptr(), 0), -1, "cap 0");
    assert_eq!(one[0], 0x55, "cap 0 writes nothing");
    assert_eq!(
        pvm_rt::pvmrt_identity(one.as_mut_ptr(), 1),
        -1,
        "does not fit"
    );
    assert_eq!(one[0], 0, "a truncated identity is still NUL-terminated");
    let mut buf = [0 as c_char; 512];
    assert_eq!(pvm_rt::pvmrt_identity(buf.as_mut_ptr(), buf.len()), 0);
    let s = unsafe { CStr::from_ptr(buf.as_ptr()) }.to_str().unwrap();
    assert!(
        s.starts_with("{\"cache\":\"none\"") && s.contains("\"targetIsa\":\"pulley64\""),
        "{s}"
    );
}

#[test]
fn run_cli_refuses_invalid_arguments_before_touching_them() {
    let (b, want) = bundle();
    let ok_emit: pvm_rt::EmitFn = Some(collect_refused);
    let arg = c"a";
    let one = [arg.as_ptr()];
    let with_null = [arg.as_ptr(), null()];
    // no emit callback: refused first, whatever else is valid
    let (rc, e) = call(
        b.as_ptr(),
        b.len(),
        want.as_ptr(),
        null(),
        0,
        64 << 20,
        1000,
        None,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("no emit callback"), "{e}");
    // argv null with argc > 0: refused before any pointer arithmetic
    let (rc, e) = call(
        b.as_ptr(),
        b.len(),
        want.as_ptr(),
        null(),
        1,
        64 << 20,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("argv is null"), "{e}");
    // a negative or too large argc
    let (rc, e) = call(
        b.as_ptr(),
        b.len(),
        want.as_ptr(),
        one.as_ptr(),
        -1,
        64 << 20,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("argc -1"), "{e}");
    let (rc, e) = call(
        b.as_ptr(),
        b.len(),
        want.as_ptr(),
        one.as_ptr(),
        pvm_rt::MAX_ARGS + 1,
        64 << 20,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("argc"), "{e}");
    // a null entry within argc: refused, not silently truncated
    let (rc, e) = call(
        b.as_ptr(),
        b.len(),
        want.as_ptr(),
        with_null.as_ptr(),
        2,
        64 << 20,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("argv[1] is null"), "{e}");
    // bundle: null, empty, and a length past the cap (the slice is never made, so the small buffer is never over-read)
    let (rc, e) = call(
        null(),
        10,
        want.as_ptr(),
        null(),
        0,
        64 << 20,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("no bundle"), "{e}");
    let (rc, e) = call(
        b.as_ptr(),
        0,
        want.as_ptr(),
        null(),
        0,
        64 << 20,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("no bundle"), "{e}");
    let (rc, e) = call(
        b.as_ptr(),
        pvm_rt::MAX_BUNDLE_BYTES + 1,
        want.as_ptr(),
        null(),
        0,
        64 << 20,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("exceeds"), "{e}");
    // no digest, no memory limit, no deadline
    let (rc, e) = call(
        b.as_ptr(),
        b.len(),
        null(),
        null(),
        0,
        64 << 20,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("no expected digest"), "{e}");
    let (rc, e) = call(
        b.as_ptr(),
        b.len(),
        want.as_ptr(),
        null(),
        0,
        0,
        1000,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("mem_limit"), "{e}");
    let (rc, e) = call(
        b.as_ptr(),
        b.len(),
        want.as_ptr(),
        null(),
        0,
        64 << 20,
        0,
        ok_emit,
    );
    assert_eq!(rc, -1);
    assert!(e.contains("deadline_ms"), "{e}");
    // a null err buffer is allowed: the refusal is still -1
    let mut code: c_int = 0;
    assert_eq!(
        pvm_rt::pvmrt_run_cli(
            b.as_ptr(),
            b.len(),
            want.as_ptr(),
            null(),
            1,
            64 << 20,
            1000,
            ok_emit,
            &mut code,
            null_mut(),
            null_mut(),
            null_mut(),
            0
        ),
        -1
    );
    // none of the refused calls emitted output
    assert!(
        REFUSED_OUT.lock().unwrap().is_empty(),
        "a refused call emitted output"
    );
}

#[test]
fn a_valid_call_through_the_boundary_runs_the_component() {
    let (b, want) = bundle();
    let (a0, a1) = (c"a", c"b");
    let argv = [a0.as_ptr(), a1.as_ptr()];
    OUT.lock().unwrap().clear();
    let mut err = [0 as c_char; 512];
    let (mut code, mut cms, mut rms): (c_int, u64, u64) = (-99, 0, 0);
    let rc = pvm_rt::pvmrt_run_cli(
        b.as_ptr(),
        b.len(),
        want.as_ptr(),
        argv.as_ptr(),
        2,
        256 << 20,
        60_000,
        Some(collect),
        &mut code,
        &mut cms,
        &mut rms,
        err.as_mut_ptr(),
        err.len(),
    );
    assert_eq!(
        rc,
        0,
        "{}",
        unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy()
    );
    assert_eq!(code, 0);
    let out: Vec<u8> = OUT
        .lock()
        .unwrap()
        .iter()
        .filter(|(s, _)| *s == 1)
        .flat_map(|(_, o)| o.clone())
        .collect();
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "pvm-rt conformance v1\nargs 2\nprimes 10000 sum 496165411 fnv1a 6829bbb248bc4034\n"
    );
}
