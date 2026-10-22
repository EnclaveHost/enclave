;; nn-probe.wat - the runtime's wasi-nn ggml probe (probe-nn-ggml.sh): a graph the runtime PRELOADED at start, under its
;; directory's name ("probe"), is found by name and gets an execution context, through the witx wasi-nn interface.
;; run() -> 7 only when both succeed; 1 or 2 says which failed.
(module
  (import "wasi_ephemeral_nn" "load_by_name" (func $load_by_name (param i32 i32 i32) (result i32)))
  (import "wasi_ephemeral_nn" "init_execution_context" (func $init (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 16) "probe")
  (func (export "run") (result i32)
    (if (i32.ne (call $load_by_name (i32.const 16) (i32.const 5) (i32.const 64)) (i32.const 0)) (then (return (i32.const 1))))
    (if (i32.ne (call $init (i32.load (i32.const 64)) (i32.const 68)) (i32.const 0)) (then (return (i32.const 2))))
    (i32.const 7)))
