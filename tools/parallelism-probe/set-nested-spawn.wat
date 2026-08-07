;; Negative probe: a SET worker calling thread.spawn-ref AGAIN (nested spawn).
;; The worker cannot re-enter the primary component's store, so this must TRAP
;; that worker with a clear message — never abort the process, never kill the
;; host, and never silently race.
;;
;; Expected on stderr:
;;   set-thread-1 trapped (thread ends; siblings continue): ...
;;   Caused by: a shared-everything-threads worker cannot call back into ...
;; and then a CLEAN return of 1 from run(): the host survives the worker's
;; death. The bounded wait below is the point — the worker never bumps the
;; counter (it trapped), so this demonstrates that losing a worker is the
;; guest's problem to handle, not the host's.
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
      ;; bounded wait: give the worker time to run and trap, then carry on.
      ;; It never bumps the counter, so this always times out — proving the
      ;; host is still alive and able to make progress.
      (drop (memory.atomic.wait32 (i32.const 0) (i32.const 0) (i64.const 2000000000)))
      (i32.const 1))
  )
  (core instance $i (instantiate $m (with "" (instance (export "spawn" (func $spawn))))))
  (alias core export $i "run" (core func $run))
  (func (export "run") (result u32) (canon lift (core func $run)))
)
