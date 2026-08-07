(component
  (core type $start (shared (func (param i32))))
  (core func $ap    (canon thread.available_parallelism))
  (core func $spawn (canon thread.spawn-ref $start))

  (core module $m
    (type $start_t (shared (func (param i32))))
    (type $ap_t    (shared (func (result i32))))
    (type $spawn_t (shared (func (param (ref null $start_t) i32) (result i32))))
    (type $run_t   (func (result i32)))

    (import "" "ap"    (func $ap    (type $ap_t)))
    (import "" "spawn" (func $spawn (type $spawn_t)))

    (memory (export "memory") 1 1 shared)

    ;; what a spawned thread would run: atomically add ctx into shared memory
    (func $worker (type $start_t) (param $ctx i32)
      (drop (i32.atomic.rmw.add (i32.const 0) (local.get $ctx))))
    (elem declare func $worker)

    (func (export "run") (type $run_t) (result i32)
      (local $rc i32)
      ;; ask SET to run $worker(7) on another thread
      (local.set $rc (call $spawn (ref.func $worker) (i32.const 7)))
      ;; negative = spawn failed -> sequential fallback, same work inline
      (if (i32.lt_s (local.get $rc) (i32.const 0))
        (then (call $worker (i32.const 7))))
      (i32.add
        (i32.mul (call $ap) (i32.const 1000))
        (i32.atomic.load (i32.const 0))))
  )
  (core instance $i (instantiate $m (with "" (instance
    (export "ap" (func $ap))
    (export "spawn" (func $spawn))))))
  (alias core export $i "run" (core func $run))
  (func (export "run") (result u32) (canon lift (core func $run)))
)
