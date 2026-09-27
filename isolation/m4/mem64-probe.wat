;; Exercise the 64-bit canonical ABI, including copying a string into memory.
(component
  (core module $m
    (memory (export "memory") i64 1)
    (func (export "cabi_realloc") (param i64 i64 i64 i64) (result i64) (i64.const 16))
    (func (export "f") (param $ptr i64) (param $len i64) (result i32)
      (if (result i32) (i32.eq (i32.load8_u (local.get $ptr)) (i32.const 116))
        (then (i32.wrap_i64 (local.get $len))) (else (i32.const 0)))))
  (core instance $i (instantiate $m))
  (func (export "f") (param "s" string) (result u32)
    (canon lift (core func $i "f") (memory $i "memory") (realloc (func $i "cabi_realloc")) string-encoding=utf8)))
