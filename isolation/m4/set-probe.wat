;; Capability probe: actual worker, plain table/type used by SET toolchain.
;; No inline fallback: spawn failure returns zero; success must return seven.
(component
  (core type $start (func (param i32)))

  (core module $a
    (type $start_t (func (param i32)))
    (memory (export "memory") 1 1 shared)
    (table (export "workers") 1 1 funcref)
    (func $worker (type $start_t) (param $ctx i32)
      (drop (i32.atomic.rmw.add (i32.const 0) (local.get $ctx)))
      (drop (memory.atomic.notify (i32.const 0) (i32.const -1))))
    (elem (table 0) (i32.const 0) funcref (ref.func $worker))
  )
  (core instance $ia (instantiate $a))
  (alias core export $ia "workers" (core table $t))
  (alias core export $ia "memory" (core memory $mem))

  (core func $spawn (canon thread.spawn-indirect $start (table $t)))

  (core module $b
    (type $spawn_t (func (param i32 i32) (result i32)))
    (import "env" "memory" (memory 1 1 shared))
    (import "env" "spawn" (func $spawn (type $spawn_t)))
    (func (export "run") (result i32)
      (local $rc i32)
      (local $c i32)
      ;; spawn table element 0 with ctx=7
      (local.set $rc (call $spawn (i32.const 0) (i32.const 7)))
      (if (i32.lt_s (local.get $rc) (i32.const 0))
        (then (return (i32.const 0))))
      (block $done
        (loop $w
          (local.set $c (i32.atomic.load (i32.const 0)))
          (br_if $done (i32.eq (local.get $c) (i32.const 7)))
          (drop (memory.atomic.wait32 (i32.const 0) (local.get $c) (i64.const -1)))
          (br $w)))
      (i32.atomic.load (i32.const 0)))
  )
  (core instance $ib (instantiate $b (with "env" (instance
    (export "memory" (memory $mem))
    (export "spawn" (func $spawn))))))
  (alias core export $ib "run" (core func $run))
  (func (export "run") (result u32) (canon lift (core func $run)))
)
