(component
  (core func $ap (canon thread.available_parallelism))
  (core module $m
    (type $shared_t (shared (func (result i32))))
    (type $plain_t (func (result i32)))
    (import "" "ap" (func $ap (type $shared_t)))
    (func (export "run") (type $plain_t) (call $ap))
  )
  (core instance $i (instantiate $m (with "" (instance (export "ap" (func $ap))))))
  (alias core export $i "run" (core func $run))
  (func (export "run") (result u32) (canon lift (core func $run)))
)
