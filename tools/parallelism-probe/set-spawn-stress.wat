;; SET stress probe, built for ThreadSanitizer / soak runs:
;;   run(rounds, threads, iters)
;; Each round spawns `threads` workers; every worker hammers ONE contended
;; address with atomic adds `iters` times, one worker per round also calls
;; memory.grow (exercising the SharedMemory growth lock cross-thread), then
;; bumps the completion counter and notifies. Main joins each round via
;; futex wait before starting the next, so spawn/execute/teardown churn is
;; continuous.
;;
;; Returns rounds * threads (total completions observed).
;;
;;   wasmtime run -W threads,shared-everything-threads,component-model-threading,shared-memory \
;;     --invoke 'run(50, 8, 10000)' set-spawn-stress.wat
(component
  (core type $start (shared (func (param i32))))
  (core func $spawn (canon thread.spawn-ref $start))

  (core module $m
    (type $start_t (shared (func (param i32))))
    (type $spawn_t (shared (func (param (ref null $start_t) i32) (result i32))))
    (import "" "spawn" (func $spawn (type $spawn_t)))

    (memory (export "memory") 1 64 shared)

    ;; 0:  i32 per-round completion counter (atomic, futex word)
    ;; 8:  i64 iteration count
    ;; 16: i32 contended accumulator
    ;; 24: i64 total completions (atomic)
    (func $worker (type $start_t) (param $ctx i32)
      (local $i i64)
      (local.set $i (i64.load (i32.const 8)))
      (block $done
        (loop $l
          (br_if $done (i64.eqz (local.get $i)))
          (drop (i32.atomic.rmw.add (i32.const 16) (i32.const 1)))
          (local.set $i (i64.sub (local.get $i) (i64.const 1)))
          (br $l)))
      ;; ctx==0 worker also exercises shared-memory growth under load
      (if (i32.eqz (local.get $ctx))
        (then (drop (memory.grow (i32.const 1)))))
      (drop (i64.atomic.rmw.add (i32.const 24) (i64.const 1)))
      (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1)))
      (drop (memory.atomic.notify (i32.const 0) (i32.const -1))))
    (elem declare func $worker)

    (func (export "run") (param $rounds i32) (param $threads i32) (param $iters i64) (result i64)
      (local $r i32)
      (local $k i32)
      (local $rc i32)
      (local $c i32)
      (i64.store (i32.const 8) (local.get $iters))
      (block $all
        (loop $round
          (br_if $all (i32.ge_u (local.get $r) (local.get $rounds)))
          (i32.atomic.store (i32.const 0) (i32.const 0))
          (local.set $k (i32.const 0))
          (block $spawned
            (loop $s
              (br_if $spawned (i32.ge_u (local.get $k) (local.get $threads)))
              (local.set $rc (call $spawn (ref.func $worker) (local.get $k)))
              (if (i32.lt_s (local.get $rc) (i32.const 0))
                (then (call $worker (local.get $k))))
              (local.set $k (i32.add (local.get $k) (i32.const 1)))
              (br $s)))
          (block $joined
            (loop $w
              (local.set $c (i32.atomic.load (i32.const 0)))
              (br_if $joined (i32.eq (local.get $c) (local.get $threads)))
              (drop (memory.atomic.wait32 (i32.const 0) (local.get $c) (i64.const -1)))
              (br $w)))
          (local.set $r (i32.add (local.get $r) (i32.const 1)))
          (br $round)))
      (i64.atomic.load (i32.const 24)))
  )
  (core instance $i (instantiate $m (with "" (instance
    (export "spawn" (func $spawn))))))
  (alias core export $i "run" (core func $run))
  (func (export "run") (param "rounds" u32) (param "threads" u32) (param "iters" u64) (result u64)
    (canon lift (core func $run)))
)
