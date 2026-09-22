;; Is an atomic RMW actually ATOMIC on this engine, or merely a load-modify-store that usually
;; gets away with it?
;;
;; run(threads, iters) has every worker add 1 to ONE shared address, `iters` times, and returns the
;; final value. The answer must be EXACTLY threads*iters. A non-atomic implementation loses updates
;; under contention and comes back short - and unlike a completion counter, every single one of the
;; hammered adds is checked, because the sum IS the result.
;;
;; The workers are released by a barrier (they spin on a start flag the main thread sets after all
;; of them have registered), so they hit the address aligned rather than at whatever offsets the
;; scheduler happens to produce.
(component
  (core type $start (shared (func (param i32))))

  (core module $a
    (type $start_t (shared (func (param i32))))
    ;; 0: the contended counter   4: how many workers have registered   8: the start flag
    ;; 12: how many have finished  16: iterations per worker
    (memory (export "memory") 1 1 shared)
    (table (export "workers") shared 1 1 (ref null (shared func)))
    (func $worker (type $start_t) (param $ctx i32)
      (local $i i32)
      (drop (i32.atomic.rmw.add (i32.const 4) (i32.const 1)))        ;; registered
      (block $go                                                      ;; barrier: wait for the flag
        (loop $spin
          (br_if $go (i32.eq (i32.atomic.load (i32.const 8)) (i32.const 1)))
          (drop (memory.atomic.wait32 (i32.const 8) (i32.const 0) (i64.const -1)))
          (br $spin)))
      (local.set $i (i32.const 0))
      (block $done
        (loop $more
          (br_if $done (i32.ge_u (local.get $i) (i32.atomic.load (i32.const 16))))
          (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1)))     ;; THE operation under test
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $more)))
      (drop (i32.atomic.rmw.add (i32.const 12) (i32.const 1)))        ;; finished
      (drop (memory.atomic.notify (i32.const 12) (i32.const -1))))
    (elem (table 0) (i32.const 0) (ref null (shared func)) (ref.func $worker))
  )
  (core instance $ia (instantiate $a))
  (alias core export $ia "workers" (core table $t))
  (alias core export $ia "memory" (core memory $mem))
  (core func $spawn (canon thread.spawn-indirect $start (table $t)))

  (core module $b
    ;; $run_t is declared SEPARATELY and first. Without it the encoder deduplicates run's inline
    ;; (i32,i32)->i32 against $spawn_t, which is SHARED, and the component then refuses to lift a
    ;; shared core function: "lowered function type ... does not match ... shared: true".
    (type $run_t (func (param i32 i32) (result i32)))
    (type $spawn_t (shared (func (param i32 i32) (result i32))))
    (import "env" "memory" (memory 1 1 shared))
    (import "env" "spawn" (func $spawn (type $spawn_t)))
    (func (export "run") (type $run_t) (param $threads i32) (param $iters i32) (result i32)
      (local $i i32) (local $rc i32) (local $inline i32)
      (i32.atomic.store (i32.const 16) (local.get $iters))
      ;; spawn them all; any that refuse are run inline afterwards so the total still checks out
      (local.set $i (i32.const 0))
      (block $spawned
        (loop $s
          (br_if $spawned (i32.ge_s (local.get $i) (local.get $threads)))
          (local.set $rc (call $spawn (i32.const 0) (local.get $i)))
          (if (i32.lt_s (local.get $rc) (i32.const 0))
            (then (local.set $inline (i32.add (local.get $inline) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $s)))
      ;; wait until every spawned worker has registered, then release them together
      (block $ready
        (loop $w
          (br_if $ready (i32.ge_u (i32.atomic.load (i32.const 4))
                                  (i32.sub (local.get $threads) (local.get $inline))))
          (br $w)))
      (i32.atomic.store (i32.const 8) (i32.const 1))
      (drop (memory.atomic.notify (i32.const 8) (i32.const -1)))
      ;; whatever could not be spawned, this thread does, so the expected total is unconditional
      (block $donein
        (loop $more
          (br_if $donein (i32.le_s (local.get $inline) (i32.const 0)))
          (local.set $i (i32.const 0))
          (block $one
            (loop $it
              (br_if $one (i32.ge_u (local.get $i) (local.get $iters)))
              (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $it)))
          (local.set $inline (i32.sub (local.get $inline) (i32.const 1)))
          (br $more)))
      ;; join
      (block $alldone
        (loop $j
          (br_if $alldone (i32.ge_u (i32.atomic.load (i32.const 12))
                                    (i32.sub (local.get $threads) (i32.const 0))))
          (br_if $alldone (i32.ge_u (i32.atomic.load (i32.const 12))
                                    (i32.sub (local.get $threads) (i32.const 0))))
          (drop (memory.atomic.wait32 (i32.const 12) (i32.atomic.load (i32.const 12)) (i64.const 1000000)))
          (br $j)))
      (i32.atomic.load (i32.const 0)))
  )
  (core instance $ib (instantiate $b (with "env" (instance
    (export "memory" (memory $mem))
    (export "spawn" (func $spawn))))))
  (alias core export $ib "run" (core func $run))
  (func (export "run") (param "threads" u32) (param "iters" u32) (result u32) (canon lift (core func $run)))
)
