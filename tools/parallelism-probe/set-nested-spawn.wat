;; Negative probe: a SET worker calling thread.spawn-ref AGAIN (nested spawn).
;; The worker cannot re-enter the primary component's store, so this must TRAP
;; the worker thread with a clear message — never abort the process, and never
;; silently race. Expected: "set-thread-1: ... cannot call back into the
;; component that spawned it" on stderr, exit 1.
(component
  (core type $start (shared (func (param i32))))
  (core func $spawn (canon thread.spawn-ref $start))

  (core module $m
    (type $start_t (shared (func (param i32))))
    (type $spawn_t (shared (func (param (ref null $start_t) i32) (result i32))))
    (import "" "spawn" (func $spawn (type $spawn_t)))
    (memory (export "memory") 1 1 shared)

    (func $worker (type $start_t) (param $ctx i32)
      ;; the nested spawn: legal-looking guest code, must trap not abort
      (drop (call $spawn (ref.func $worker) (i32.const 0))))
    (elem declare func $worker)

    (func (export "run") (result i32)
      (local $c i32)
      (drop (call $spawn (ref.func $worker) (i32.const 1)))
      ;; park so the worker gets a chance to run and trap
      (block $done
        (loop $w
          (local.set $c (i32.atomic.load (i32.const 0)))
          (br_if $done (i32.eq (local.get $c) (i32.const 99)))
          (drop (memory.atomic.wait32 (i32.const 0) (local.get $c) (i64.const 2000000000)))
          (br $w)))
      (i32.const 0))
  )
  (core instance $i (instantiate $m (with "" (instance (export "spawn" (func $spawn))))))
  (alias core export $i "run" (core func $run))
  (func (export "run") (result u32) (canon lift (core func $run)))
)
