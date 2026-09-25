//! A generational slot table for the apps this enclave runs at once.
//!
//! The bug this replaces (found 2026-09-25 on nucbox-k11, two tenants sharing "slot 3"):
//! `ee_rt_run` used to `APPS[id-1].take()` the running app OUT of its slot so the run thread could
//! own the non-`Send` `Store`. That left the slot reading `None`, so the very next `ee_rt_open`
//! reused it and handed a SECOND live app the SAME handle. From then on `ee_rt_stop(3)` reached
//! whichever app's engine was in `RUN_ENGINES[2]` and `ee_rt_close(3)` freed whichever app was in
//! `APPS[2]` -- i.e. an ordinary owner-initiated restart of one tenant could stop or free a
//! DIFFERENT tenant's app. A cross-tenant action from an in-bounds handle is a tenant-safety bug,
//! not a reliability one.
//!
//! The fix is the standard generational-index pattern, made safe by construction rather than by
//! caller discipline:
//!   * an app that is running, or checked out to serve a request, KEEPS its slot, so `insert` can
//!     never reuse a live slot and hand out a duplicate handle;
//!   * every handle carries the generation of the occupancy it was minted for, so a handle for an
//!     app that has since stopped no longer resolves to whatever app took the slot next; and
//!   * the run thread's `finish_run` (and the request path's `checkin`) only act when the
//!     generation still matches, so an app's teardown racing a new occupant of the same slot
//!     cannot free the newcomer.
//!
//! Handle layout (u32, opaque to the host, which only echoes it back):
//!   bits 0..SLOT_BITS  = slot index (0..MAX_APPS-1)
//!   bits SLOT_BITS..   = generation, monotonic from 1, so handle 0 is never valid.
//!
//! `no_std`: the table itself allocates nothing; it holds the caller's `T`/`E` in place. A tiny
//! spinlock guards the array because `ee_rt_stop` may be called from a different thread than the
//! one running the app (the doc on `ee_rt_stop` promises exactly that), and the old `static mut`
//! access was an unsynchronised data race across those threads. The lock is held only for the
//! table transitions, never across an app's execution -- an app is checked OUT of the table for
//! the duration of a request or a run and checked back in afterwards.

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicBool, Ordering};

pub const MAX_APPS: usize = 8;
const SLOT_BITS: u32 = 3; // ceil(log2(MAX_APPS)); MAX_APPS must be <= 1 << SLOT_BITS
const SLOT_MASK: u32 = (1 << SLOT_BITS) - 1;
/// The generation occupies the rest of the handle. It is kept masked to exactly this width so that
/// the value stored in an `Entry` is byte-for-byte what a handle carries -- otherwise a generation
/// past `2^GEN_BITS` would be truncated by the shift in `make_handle`, the stored and recovered
/// generations would diverge, and (once the counter wrapped) a reused slot could mint a handle
/// equal to a live one: exactly the wrong-tenant reach this table exists to forbid. Found in review
/// (d1, 2026-09-25).
const GEN_BITS: u32 = u32::BITS - SLOT_BITS;
const GEN_MASK: u32 = (1u32 << GEN_BITS) - 1;

const _: () = assert!(MAX_APPS <= (1 << SLOT_BITS));
// The generation field must not overlap the slot field, and a masked generation shifted into place
// must stay within a u32.
const _: () = assert!(SLOT_BITS + GEN_BITS == u32::BITS);
const _: () = assert!(GEN_MASK <= (u32::MAX >> SLOT_BITS));

fn make_handle(slot: usize, gen: u32) -> u32 {
    // The generation is always minted within GEN_MASK (see `next_gen` in `insert`) and never 0, so
    // handle 0 is never valid and the shift below never loses a generation bit.
    debug_assert!(gen != 0 && gen <= GEN_MASK, "generation out of the handle's field");
    debug_assert!((slot as u32) <= SLOT_MASK, "slot out of the handle's field");
    (gen << SLOT_BITS) | (slot as u32)
}
fn split_handle(handle: u32) -> (usize, u32) {
    ((handle & SLOT_MASK) as usize, handle >> SLOT_BITS)
}

/// What `remove` (a host close) did, so the caller can report it and drop the value outside the
/// lock.
pub enum Removed<T> {
    /// The idle app was taken out; drop it.
    Took(T),
    /// The app was mid-request; it is marked to free itself when the request finishes.
    Deferred,
    /// The handle names a running wasi:cli app (close it via stop, not close), or nothing.
    NotClosable,
}

enum Entry<T, E> {
    Empty,
    /// Loaded and idle: a wasi:http app between requests, or a wasi:cli app before it runs.
    Loaded { gen: u32, val: T, engine: E },
    /// A wasi:http app checked out to serve one request. The value is on the serving thread; the
    /// slot stays occupied. `close_pending` records a host close that arrived mid-request.
    Busy { gen: u32, engine: E, close_pending: bool },
    /// A wasi:cli app whose `Store` has been moved to its run thread. The engine stays so
    /// `ee_rt_stop` can interrupt it.
    Running { gen: u32, engine: E },
}

struct Inner<T, E> {
    entries: [Entry<T, E>; MAX_APPS],
    next_gen: u32,
}

pub struct SlotTable<T, E> {
    lock: AtomicBool,
    inner: UnsafeCell<Inner<T, E>>,
}

// The spinlock below serialises every access to `inner`; nothing hands out a reference that
// outlives the lock. This is what makes concurrent open/stop/finish sound.
unsafe impl<T: Send, E: Send> Sync for SlotTable<T, E> {}

struct Guard<'a, T, E> {
    lock: &'a AtomicBool,
    inner: &'a mut Inner<T, E>,
}
impl<T, E> Drop for Guard<'_, T, E> {
    fn drop(&mut self) {
        self.lock.store(false, Ordering::Release);
    }
}

impl<T, E: Clone> SlotTable<T, E> {
    pub const fn new() -> Self {
        // `Entry::Empty` is not `Copy`, so the array is spelled out; MAX_APPS is 8.
        SlotTable {
            lock: AtomicBool::new(false),
            inner: UnsafeCell::new(Inner {
                entries: [
                    Entry::Empty, Entry::Empty, Entry::Empty, Entry::Empty,
                    Entry::Empty, Entry::Empty, Entry::Empty, Entry::Empty,
                ],
                next_gen: 1,
            }),
        }
    }

    fn lock(&self) -> Guard<'_, T, E> {
        while self
            .lock
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            core::hint::spin_loop();
        }
        // SAFETY: we hold the lock; the guard releases it on drop and is the only path to `inner`.
        Guard { lock: &self.lock, inner: unsafe { &mut *self.inner.get() } }
    }

    /// Install a loaded app in the first free slot. Returns its handle, or `None` if all
    /// `MAX_APPS` slots are occupied (loaded, busy OR running). `engine` is kept for `ee_rt_stop`.
    pub fn insert(&self, val: T, engine: E) -> Option<u32> {
        let g = self.lock();
        for (i, e) in g.inner.entries.iter_mut().enumerate() {
            if matches!(e, Entry::Empty) {
                // `next_gen` lives in the masked generation space [1, GEN_MASK]: the value handed
                // out is always what a handle can carry, and advancing wraps within that space and
                // skips 0 so handle 0 stays invalid. Storing the SAME masked value is what keeps
                // the comparisons in checkout/checkin/finish_run/running_engine exact.
                let gen = g.inner.next_gen;
                g.inner.next_gen = (g.inner.next_gen + 1) & GEN_MASK;
                if g.inner.next_gen == 0 {
                    g.inner.next_gen = 1;
                }
                *e = Entry::Loaded { gen, val, engine };
                return Some(make_handle(i, gen));
            }
        }
        None
    }

    /// Check a loaded wasi:http app OUT to serve one request on the caller's thread. The slot stays
    /// occupied (`Busy`) so nothing reuses it; call `checkin` with the value afterwards. Returns
    /// `None` if the handle does not name a currently-idle loaded app.
    pub fn checkout(&self, handle: u32) -> Option<T> {
        let (slot, gen) = split_handle(handle);
        if slot >= MAX_APPS {
            return None;
        }
        let g = self.lock();
        let e = &mut g.inner.entries[slot];
        match core::mem::replace(e, Entry::Empty) {
            Entry::Loaded { gen: eg, val, engine } if eg == gen => {
                *e = Entry::Busy { gen, engine, close_pending: false };
                Some(val)
            }
            other => {
                *e = other;
                None
            }
        }
    }

    /// Return a checked-out app to its slot. If a host close arrived while it was serving, the app
    /// is freed instead of reinstalled (and this returns `true`, "was closed"); the value is
    /// dropped here in either case only when freed -- otherwise it is stored back. A generation
    /// mismatch (the slot was force-freed) also drops the value.
    pub fn checkin(&self, handle: u32, val: T) -> bool {
        let (slot, gen) = split_handle(handle);
        if slot >= MAX_APPS {
            return true; // nowhere to put it back: it is gone
        }
        let g = self.lock();
        let e = &mut g.inner.entries[slot];
        match core::mem::replace(e, Entry::Empty) {
            Entry::Busy { gen: eg, engine, close_pending } if eg == gen => {
                if close_pending {
                    // leave Empty; `val` drops at end of scope
                    true
                } else {
                    *e = Entry::Loaded { gen, val, engine };
                    false
                }
            }
            other => {
                *e = other; // slot was reused under a new gen; drop `val`
                true
            }
        }
    }

    /// Take a loaded wasi:cli app out to run it on the caller's thread, leaving the slot occupied
    /// (`Running`) so nothing reuses it. Returns the moved value, or `None`.
    pub fn begin_run(&self, handle: u32) -> Option<T> {
        let (slot, gen) = split_handle(handle);
        if slot >= MAX_APPS {
            return None;
        }
        let g = self.lock();
        let e = &mut g.inner.entries[slot];
        match core::mem::replace(e, Entry::Empty) {
            Entry::Loaded { gen: eg, val, engine } if eg == gen => {
                *e = Entry::Running { gen, engine };
                Some(val)
            }
            other => {
                *e = other;
                None
            }
        }
    }

    /// The run thread calls this once its app has returned/trapped and its `Store` is dropped.
    /// Clears the slot ONLY if it still holds this exact occupancy; if the slot was already freed
    /// and reused (a different generation), it does nothing. Returns whether it cleared the slot.
    pub fn finish_run(&self, handle: u32) -> bool {
        let (slot, gen) = split_handle(handle);
        if slot >= MAX_APPS {
            return false;
        }
        let g = self.lock();
        let e = &mut g.inner.entries[slot];
        if matches!(e, Entry::Running { gen: eg, .. } if *eg == gen) {
            *e = Entry::Empty;
            true
        } else {
            false
        }
    }

    /// A clone of the engine for an app running under this exact handle, for `ee_rt_stop`. `None`
    /// if the handle names no running app -- which is what makes a wrong-tenant stop impossible: a
    /// handle for a stopped/absent app never yields an engine, and a reused slot has a different
    /// generation.
    pub fn running_engine(&self, handle: u32) -> Option<E> {
        let (slot, gen) = split_handle(handle);
        if slot >= MAX_APPS {
            return None;
        }
        let g = self.lock();
        match &g.inner.entries[slot] {
            Entry::Running { gen: eg, engine } if *eg == gen => Some(engine.clone()),
            _ => None,
        }
    }

    /// Free a slot the host asked to close (wasi:http teardown). Only acts on the exact occupancy
    /// named. An idle app is taken out (`Took`, drop it outside the lock); an app mid-request is
    /// marked to free itself on `checkin` (`Deferred`); a running wasi:cli app or a stale/absent
    /// handle is `NotClosable`.
    pub fn remove(&self, handle: u32) -> Removed<T> {
        let (slot, gen) = split_handle(handle);
        if slot >= MAX_APPS {
            return Removed::NotClosable;
        }
        let g = self.lock();
        let e = &mut g.inner.entries[slot];
        match core::mem::replace(e, Entry::Empty) {
            Entry::Loaded { gen: eg, val, .. } if eg == gen => Removed::Took(val),
            Entry::Busy { gen: eg, engine, .. } if eg == gen => {
                *e = Entry::Busy { gen, engine, close_pending: true };
                Removed::Deferred
            }
            other => {
                *e = other;
                Removed::NotClosable
            }
        }
    }

    /// Test-only: drive the generation counter near a wrap without 2^29 real inserts.
    #[cfg(test)]
    fn set_next_gen(&self, g: u32) {
        let guard = self.lock();
        guard.inner.next_gen = g;
    }

    /// True if the handle names an app that is currently running.
    pub fn is_running(&self, handle: u32) -> bool {
        let (slot, gen) = split_handle(handle);
        if slot >= MAX_APPS {
            return false;
        }
        let g = self.lock();
        matches!(&g.inner.entries[slot], Entry::Running { gen: eg, .. } if *eg == gen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering as O};

    // A dummy "engine" whose clones share a live counter, so a test can see whether the RIGHT
    // occupancy's engine was reached.
    #[derive(Clone)]
    struct Eng(Arc<AtomicUsize>);
    impl Eng {
        fn new() -> Self { Eng(Arc::new(AtomicUsize::new(0))) }
        fn bump(&self) { self.0.fetch_add(1, O::SeqCst); }
        fn count(&self) -> usize { self.0.load(O::SeqCst) }
    }

    #[test]
    fn two_apps_get_distinct_handles_and_slots() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(a, b);
        assert_ne!(split_handle(a).0, split_handle(b).0, "distinct slots");
    }

    #[test]
    fn a_running_app_keeps_its_slot_so_open_cannot_reuse_it() {
        // The exact regression: run A, then open B. B must NOT land in A's slot.
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let (slot_a, _) = split_handle(a);
        let val = t.begin_run(a).expect("A begins running");
        assert_eq!(val, "A");
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(split_handle(b).0, slot_a, "B must not reuse the running app's slot");
        assert!(t.is_running(a));
    }

    #[test]
    fn a_busy_http_app_keeps_its_slot_too() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let (slot_a, _) = split_handle(a);
        let v = t.checkout(a).expect("A checked out for a request");
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(split_handle(b).0, slot_a, "B must not reuse a busy app's slot");
        assert!(!t.checkin(a, v), "A goes back, not closed");
        assert!(t.checkout(a).is_some(), "A is idle-loaded again");
    }

    #[test]
    fn stop_reaches_only_the_named_running_app() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let ea = Eng::new();
        let eb = Eng::new();
        let a = t.insert("A", ea.clone()).unwrap();
        let b = t.insert("B", eb.clone()).unwrap();
        t.begin_run(a).unwrap();
        t.begin_run(b).unwrap();
        t.running_engine(a).unwrap().bump();
        assert_eq!(ea.count(), 1);
        assert_eq!(eb.count(), 0, "B's engine must be untouched by a stop of A");
    }

    #[test]
    fn a_stale_handle_after_slot_reuse_resolves_to_nothing() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let (slot_a, _) = split_handle(a);
        assert!(matches!(t.remove(a), Removed::Took("A")));
        let b = t.insert("B", Eng::new()).unwrap();
        assert_eq!(split_handle(b).0, slot_a, "B reuses A's freed slot");
        assert_ne!(a, b, "same slot, new generation -> different handle");
        assert!(t.checkout(a).is_none());
        assert!(t.begin_run(a).is_none());
        assert!(t.running_engine(a).is_none());
        assert!(matches!(t.remove(a), Removed::NotClosable));
        assert!(!t.finish_run(a));
        assert!(t.checkout(b).is_some(), "B is reachable under its own handle");
    }

    #[test]
    fn a_close_of_a_stale_handle_cannot_free_the_new_occupant() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        assert!(matches!(t.remove(a), Removed::Took("A")));
        let b = t.insert("B", Eng::new()).unwrap();
        assert!(matches!(t.remove(a), Removed::NotClosable), "closing A's stale handle is a no-op");
        assert!(t.checkout(b).is_some(), "B is still installed");
    }

    #[test]
    fn old_completion_racing_a_new_occupant_does_not_free_it() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let (slot_a, _) = split_handle(a);
        t.begin_run(a).unwrap();
        assert!(t.finish_run(a)); // A finishes once...
        let b = t.insert("B", Eng::new()).unwrap();
        assert_eq!(split_handle(b).0, slot_a);
        t.begin_run(b).unwrap();
        assert!(!t.finish_run(a), "A's stale finish is a no-op");
        assert!(t.is_running(b), "B is still running");
    }

    #[test]
    fn a_close_during_a_request_frees_on_checkin() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let v = t.checkout(a).unwrap();
        // Host close arrives mid-request: deferred, not applied yet.
        assert!(matches!(t.remove(a), Removed::Deferred));
        // The slot is still occupied so nothing reuses it during the request.
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(split_handle(b).0, split_handle(a).0);
        // Finishing the request frees A rather than reinstalling it.
        assert!(t.checkin(a, v), "checkin reports the app was closed");
        assert!(t.checkout(a).is_none(), "A is gone");
    }

    #[test]
    fn checkin_after_force_free_drops_the_value_and_spares_the_reuser() {
        // A is checked out; the slot is somehow freed and reused (new gen) before checkin.
        let t: SlotTable<i32, Eng> = SlotTable::new();
        let a = t.insert(1, Eng::new()).unwrap();
        let (slot_a, _) = split_handle(a);
        let v = t.checkout(a).unwrap();
        // Simulate the slot being reclaimed and reused under a new generation.
        // (Only reachable in production via a bug, but checkin must be robust to it.)
        assert!(matches!(t.remove(a), Removed::Deferred));
        assert!(t.checkin(a, v)); // frees A
        let b = t.insert(2, Eng::new()).unwrap();
        assert_eq!(split_handle(b).0, slot_a);
        // A late checkin of A's OLD handle must not disturb B.
        assert!(t.checkin(a, 999));
        assert!(t.checkout(b).is_some(), "B untouched");
    }

    #[test]
    fn finish_run_clears_the_running_slot_for_reuse() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        t.begin_run(a).unwrap();
        assert!(t.is_running(a));
        assert!(t.finish_run(a));
        assert!(!t.is_running(a));
        let b = t.insert("B", Eng::new()).unwrap();
        assert_eq!(split_handle(b).0, split_handle(a).0);
    }

    #[test]
    fn the_table_fills_and_refuses_a_ninth_app() {
        let t: SlotTable<usize, Eng> = SlotTable::new();
        let mut hs = Vec::new();
        for i in 0..MAX_APPS {
            hs.push(t.insert(i, Eng::new()).expect("slot available"));
        }
        assert!(t.insert(999, Eng::new()).is_none(), "no ninth slot");
        assert!(matches!(t.remove(hs[3]), Removed::Took(_)));
        let n = t.insert(1000, Eng::new()).expect("slot freed");
        assert_eq!(split_handle(n).0, split_handle(hs[3]).0);
        assert_ne!(n, hs[3]);
    }

    #[test]
    fn a_generation_at_the_field_maximum_is_still_reachable() {
        // The truncation bug (d1's finding): a generation past 2^GEN_BITS used to store one value
        // and mint a handle carrying another, so the app became unreachable. At the exact maximum
        // the stored and recovered generations must still agree.
        let t: SlotTable<&str, Eng> = SlotTable::new();
        t.set_next_gen(GEN_MASK);
        let a = t.insert("A", Eng::new()).unwrap();
        assert_eq!(split_handle(a).1, GEN_MASK, "the handle carries the full generation");
        assert!(t.checkout(a).is_some(), "an app at the max generation is reachable");
    }

    #[test]
    fn the_generation_wraps_within_its_field_and_skips_zero() {
        let t: SlotTable<i32, Eng> = SlotTable::new();
        // Sit one below the max and mint across the wrap; every minted handle must round-trip
        // (stored gen == recovered gen, so it is reachable) and never carry generation 0.
        t.set_next_gen(GEN_MASK - 1);
        let mut gens = Vec::new();
        for i in 0..5 {
            let h = t.insert(i, Eng::new()).unwrap();
            let g = split_handle(h).1;
            assert!(g != 0 && g <= GEN_MASK, "generation {g} is in field and non-zero");
            assert!(matches!(t.remove(h), Removed::Took(v) if v == i), "app at gen {g} is reachable");
            gens.push(g);
        }
        // The sequence crossed the maximum: it includes GEN_MASK and then a low value, and 0 never
        // appears.
        assert!(gens.contains(&GEN_MASK), "the run passed through the maximum generation");
        assert!(gens.iter().all(|&g| g != 0));
        assert!(gens.iter().any(|&g| g < GEN_MASK / 2), "and wrapped back to a low generation");
    }

    #[test]
    fn handle_zero_and_out_of_range_are_never_valid() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let _ = t.insert("A", Eng::new()).unwrap();
        assert!(t.checkout(0).is_none());
        assert!(t.begin_run(0).is_none());
        assert!(!t.finish_run(0));
        assert!(t.running_engine(0).is_none());
        assert!(matches!(t.remove(0), Removed::NotClosable));
        assert!(t.checkout(u32::MAX).is_none());
    }

    #[test]
    fn concurrent_open_run_and_stop_stay_consistent() {
        use std::thread;
        let t: &'static SlotTable<usize, Eng> = Box::leak(Box::new(SlotTable::new()));
        let engs: &'static Vec<Eng> =
            Box::leak(Box::new((0..MAX_APPS).map(|_| Eng::new()).collect()));
        let mut handles = Vec::new();
        for i in 0..MAX_APPS {
            handles.push(t.insert(i, engs[i].clone()).unwrap());
        }
        let hs: &'static Vec<u32> = Box::leak(Box::new(handles));
        let mut js = Vec::new();
        for k in 0..4 {
            js.push(thread::spawn(move || {
                for _ in 0..5000 {
                    let h = hs[k];
                    if let Some(_v) = t.begin_run(h) {
                        assert!(t.is_running(h));
                        if let Some(e) = t.running_engine(h) {
                            e.bump();
                        }
                        assert!(t.finish_run(h));
                        let _ = t.insert(9000 + k, engs[k].clone());
                    }
                    // Reads of a neighbour's handle must never panic or alias.
                    let _ = t.running_engine(hs[(k + 1) % 4]);
                    let _ = t.is_running(hs[(k + 2) % 4]);
                }
            }));
        }
        for j in js {
            j.join().unwrap();
        }
    }
}
