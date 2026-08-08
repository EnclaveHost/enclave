;; NESTED SPAWN: a SET worker spawning another thread.
;;
;; What this used to claim, and it was wrong: that the worker TRAPS with
;; "cannot call back into the component that spawned it". It does not, and it
;; must not. A worker runs its own whole component instantiation, so a
;; `thread.spawn-*` from it enters through the WORKER's vmctx; the cross-thread
;; guard compares store contexts and correctly sees a match. Nested spawn is a
;; SUPPORTED operation — `run_async` installs the worker host and the thread
;; group on a worker's store precisely so `pthread_create` works from a pool
;; thread, which real pools do.
;;
;; So what this probe actually demonstrates is the BOUND, which is the thing
;; worth demonstrating: an unbounded recursive spawn tree is held by the
;; live-thread cap and by the creation-RATE limiter (the cap alone does not
;; bound a `spawn-then-exit` chain — see `max_spawn_rate` in `set_threads.rs`),
;; the host survives, and `run()` returns 1 because the worker never bumps the
;; counter. Losing a worker is the guest's problem to handle, not the host's.
;;
;;   wasmtime run -W threads,shared-everything-threads,component-model-threading,shared-memory \
;;     --invoke 'run()' set-nested-spawn.wat
;;
;; Expect: `1`, a clean exit, a bounded number of `set-thread-N` lines on
;; stderr, and no abort.
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
