;; enclave/SET: hostile guest for the shared-canonical-ABI race (blocker R4).
;;
;; The component's canonical-ABI memory is `shared`, and a SET worker rewrites
;; the bytes of a string the host is lifting, flipping them between a VALID
;; two-byte utf8 sequence (0xC3 0xA9, "é") and an INVALID one (0xC3 0x28). The
;; host's canon lift validates those bytes and, in upstream's borrowing ABI,
;; hands back a `&str` that ALIASES them — so the worker can turn an
;; already-validated `str` invalid while safe Rust holds it. That is the UB
;; this probe demonstrates and proves fixed.
;;
;; Layout: the string is at offset 16, length 2. Offset 0 is a stop flag the
;; host sets to end the worker; offset 8 counts flips, so a run that never
;; actually raced can be told apart from one that raced and survived.
;;
;; Driven by tools/parallelism-probe/cabi_race.rs, which lifts the string in a
;; loop and re-checks the bytes it was handed. Under the copy-safe canonical
;; ABI every lift is a private snapshot and the re-check always passes; under
;; the borrowing one it fails within a few thousand iterations.
(component
  (core type $start (func (param i32)))

  (core module $a
    (type $start_t (func (param i32)))
    (memory (export "memory") 1 1 shared)
    (table (export "workers") 1 1 funcref)

    ;; Flip the second payload byte between valid and invalid utf8 until told
    ;; to stop. Plain (non-atomic) stores on purpose: this is the racing writer.
    (func $flipper (type $start_t) (param $ctx i32)
      (block $done
        (loop $l
          (br_if $done (i32.atomic.load (i32.const 0)))
          (i32.store8 (i32.const 17) (i32.const 0xA9))   ;; "é" — valid
          (i32.store8 (i32.const 17) (i32.const 0x28))   ;; invalid continuation
          (drop (i32.atomic.rmw.add (i32.const 8) (i32.const 1)))
          (br $l)))
      (drop (memory.atomic.notify (i32.const 0) (i32.const -1))))

    (elem (table 0) (i32.const 0) funcref (ref.func $flipper))

    ;; Hand the host a (ptr, len) pair naming those bytes; the host lifts it as
    ;; a `string` through the canonical ABI. A `string` return needs a return
    ;; area, so this returns a pointer to the pair.
    (func (export "get") (result i32)
      (i32.store (i32.const 32) (i32.const 16))
      (i32.store (i32.const 36) (i32.const 2))
      (i32.const 32))

    ;; Required by `canon lift` when the host has to allocate; never actually
    ;; called on the lift path used here, but the option must be present.
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
      (i32.const 64))
  )
  (core instance $ia (instantiate $a))
  (alias core export $ia "workers" (core table $t))
  (alias core export $ia "memory" (core memory $mem))
  (alias core export $ia "cabi_realloc" (core func $realloc))
  (alias core export $ia "get" (core func $get))

  (core func $spawn (canon thread.spawn-indirect $start (table $t)))

  (core module $b
    (type $spawn_t (func (param i32 i32) (result i32)))
    (import "env" "memory" (memory 1 1 shared))
    (import "env" "spawn" (func $spawn (type $spawn_t)))

    ;; Lay the string down and start the flipper.
    (func (export "begin") (result i32)
      (i32.store8 (i32.const 16) (i32.const 0xC3))
      (i32.store8 (i32.const 17) (i32.const 0xA9))
      (i32.store (i32.const 0) (i32.const 0))
      (i32.store (i32.const 8) (i32.const 0))
      (call $spawn (i32.const 0) (i32.const 0)))

    ;; Stop the flipper and report how many flips it managed.
    (func (export "stop") (result i32)
      (i32.atomic.store (i32.const 0) (i32.const 1))
      (drop (memory.atomic.notify (i32.const 0) (i32.const -1)))
      (i32.atomic.load (i32.const 8)))
  )
  (core instance $ib (instantiate $b (with "env" (instance
    (export "memory" (memory $mem))
    (export "spawn" (func $spawn))))))
  (alias core export $ib "begin" (core func $begin))
  (alias core export $ib "stop" (core func $stop))

  (func (export "begin") (result s32) (canon lift (core func $begin)))
  (func (export "stop") (result s32) (canon lift (core func $stop)))
  (func (export "get") (result string)
    (canon lift (core func $get) (memory $mem) (realloc $realloc) string-encoding=utf8))
)
