;; Does a SET worker's FIRST call to an imported function reach the import, or
;; does it trap first? Same shape as set-spawn-indirect.wat, except the worker
;; body calls an import before touching memory.
;;
;;   wasmtime run -W threads,shared-everything-threads,component-model-threading,shared-memory \
;;     --invoke 'run()' set-worker-import.wat
;;
;; Expected if the transition is sound: the worker's stub import traps with the
;; engine's "cannot call the imported function" message. Observed failure mode
;; under investigation: `call stack exhausted` before the stub is entered.
(component
  (core type $start (func (param i32)))

  ;; the sibling whose export $a imports (worker views stub this out)
  (core module $h
    (func (export "note") (param i32))
  )
  (core instance $ih (instantiate $h))

  (core module $a
    (type $start_t (func (param i32)))
    (import "sib" "note" (func $note (param i32)))
    (memory (export "memory") 1 1 shared)
    (table (export "workers") 1 1 funcref)
    (func $worker (type $start_t) (param $ctx i32)
      ;; FIRST thing the worker does: call an import.
      (call $note (local.get $ctx))
      (drop (i32.atomic.rmw.add (i32.const 0) (local.get $ctx)))
      (drop (memory.atomic.notify (i32.const 0) (i32.const -1))))
    (elem (table 0) (i32.const 0) funcref (ref.func $worker))
  )
  (core instance $ia (instantiate $a (with "sib" (instance $ih))))
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
      (local $spins i32)
      (local.set $rc (call $spawn (i32.const 0) (i32.const 7)))
      (if (i32.lt_s (local.get $rc) (i32.const 0))
        (then (return (i32.const -1))))
      ;; bounded wait: a worker that dies never notifies, so don't hang.
      (block $done
        (loop $w
          (local.set $c (i32.atomic.load (i32.const 0)))
          (br_if $done (i32.eq (local.get $c) (i32.const 7)))
          (local.set $spins (i32.add (local.get $spins) (i32.const 1)))
          (br_if $done (i32.gt_u (local.get $spins) (i32.const 200)))
          (drop (memory.atomic.wait32 (i32.const 0) (local.get $c) (i64.const 10000000)))
          (br $w)))
      (i32.atomic.load (i32.const 0)))
  )
  (core instance $ib (instantiate $b (with "env" (instance
    (export "memory" (memory $mem))
    (export "spawn" (func $spawn))))))
  (alias core export $ib "run" (core func $run))
  (func (export "run") (result s32) (canon lift (core func $run)))
)
