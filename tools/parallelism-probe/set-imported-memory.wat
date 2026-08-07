;; NEGATIVE PROBE for the UB that three independent reviewers found:
;; a spawning module that IMPORTS its shared memory.
;;
;; Why this shape is dangerous: Cranelift lowers `memory.grow` and
;; `memory.atomic.wait*`/`notify` on an IMPORTED memory by calling the host
;; builtin with the DEFINING instance's vmctx, not the caller's. A worker
;; running the futex wait that every SET mutex uses would therefore land in
;; `Instance::enter_host_from_wasm` holding the PRIMARY store's vmctx and
;; materialize `&mut Store` on it from the wrong thread — the exact data race
;; the per-thread-Store design exists to prevent, on the most common SET code
;; path there is.
;;
;; Two independent defences must both hold:
;;   1. spawn REFUSES this module shape (guest sees -1, takes its fallback);
;;   2. even if a shape slips past the guard list, the cross-thread check in
;;      `Instance::enter_host_from_wasm` traps the worker.
;;
;; Expected: "1" — spawn refused, the guest ran its sequential fallback, and
;; stderr carries "module imports a memory".
(component
  (core type $start (shared (func (param i32))))
  (core func $spawn (canon thread.spawn-ref $start))

  ;; $mem defines the shared memory; $app imports it.
  (core module $mem
    (memory (export "memory") 1 100 shared)
  )
  (core instance $imem (instantiate $mem))
  (alias core export $imem "memory" (core memory $m))

  (core module $app
    (type $start_t (shared (func (param i32))))
    (type $spawn_t (shared (func (param (ref null $start_t) i32) (result i32))))
    (import "env" "memory" (memory 1 100 shared))
    (import "env" "spawn" (func $spawn (type $spawn_t)))

    ;; the worker body is exactly the dangerous one: a futex wait on the
    ;; IMPORTED memory
    (func $worker (type $start_t) (param $ctx i32)
      (drop (memory.atomic.wait32 (i32.const 0) (i32.const 0) (i64.const 1000000)))
      (drop (i32.atomic.rmw.add (i32.const 8) (i32.const 1))))
    (elem declare func $worker)

    (func (export "run") (result i32)
      (local $rc i32)
      (local.set $rc (call $spawn (ref.func $worker) (i32.const 1)))
      ;; negative = refused -> sequential fallback, no thread, no race
      (if (i32.lt_s (local.get $rc) (i32.const 0))
        (then (drop (i32.atomic.rmw.add (i32.const 8) (i32.const 1)))))
      (i32.atomic.load (i32.const 8)))
  )
  (core instance $iapp (instantiate $app (with "env" (instance
    (export "memory" (memory $m))
    (export "spawn" (func $spawn))))))
  (alias core export $iapp "run" (core func $run))
  (func (export "run") (result u32) (canon lift (core func $run)))
)
