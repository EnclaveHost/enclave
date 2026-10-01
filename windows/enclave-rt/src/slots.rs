//! The table of apps this enclave runs at once, addressed by a handle that is NEVER reused.
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
//! ## Why a monotonic id and not a generational index
//!
//! The first fix kept the array-index idea and tagged each slot with a generation packed into the
//! handle. Review (d1, then an independent audit, 2026-09-25) showed that only narrows the window:
//! a generation field is finite, so once the counter WRAPS a retired handle can equal a live one
//! again and reach a different tenant -- the exact thing the patch exists to forbid. Masking the
//! field fixed the truncation but not the reuse.
//!
//! So the handle is a GLOBAL monotonic id that is never reused within a node's run:
//!   * `insert` mints the next id (1, 2, 3, ...) and stores it with the app; the id identifies the
//!     occupancy, not the array slot.
//!   * a running or mid-request app KEEPS its entry, so nothing overwrites a live app.
//!   * every accessor finds the app by id, so a handle for an app that has stopped (its id retired)
//!     matches no entry and reaches nothing; a handle never names a later app.
//!   * when the id space is exhausted the table FAILS CLOSED -- `insert` refuses rather than wrap
//!     and risk reuse. u32 gives 4,294,967,295 opens per node boot; at any real rate that is never
//!     reached (decades of continuous uptime), and a node restart resets the counter. Refusing to
//!     open a new app is safe; reusing a handle is not.
//!
//! The array is still bounded (`MAX_APPS` concurrent apps); it is only the ADDRESS that is now an
//! id rather than an index. Lookup is a scan of at most `MAX_APPS` entries, which is nothing.
//!
//! `no_std`: the table itself allocates nothing; it holds the caller's `T`/`E` in place. A tiny
//! spinlock guards the array because `ee_rt_stop` may be called from a different thread than the
//! one running the app (the doc on `ee_rt_stop` promises exactly that), and the old `static mut`
//! access was an unsynchronised data race across those threads. The lock is held only across the
//! array reads/writes and, in `running_engine`, one `Engine` clone (an `Arc` refcount bump -- see
//! that method); it is NEVER held across an app's execution, and every value or engine a transition
//! discards is moved into a local declared before the guard so it DROPS AFTER the lock is released,
//! not under it.

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicBool, Ordering};

pub const MAX_APPS: usize = 8;

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
    Loaded { id: u32, val: T, engine: E },
    /// A wasi:http app checked out to serve one request. The value is on the serving thread; the
    /// entry stays so nothing reuses the id. `close_pending` records a host close that arrived
    /// mid-request.
    Busy { id: u32, engine: E, close_pending: bool },
    /// A wasi:cli app whose `Store` has been moved to its run thread. The engine stays so
    /// `ee_rt_stop` can interrupt it.
    Running { id: u32, engine: E },
}

impl<T, E> Entry<T, E> {
    /// The occupancy id, or 0 for an empty entry (0 is never a minted id).
    fn id(&self) -> u32 {
        match self {
            Entry::Empty => 0,
            Entry::Loaded { id, .. } | Entry::Busy { id, .. } | Entry::Running { id, .. } => *id,
        }
    }
}

struct Inner<T, E> {
    entries: [Entry<T, E>; MAX_APPS],
    /// The next id to mint. Monotonic; 0 means "exhausted" (see `insert`), so a minted id is always
    /// in 1..=u32::MAX and is never reused within a node's run.
    next_id: u32,
}

impl<T, E> Inner<T, E> {
    /// Index of the entry holding this id, if any. Ids are unique, so at most one matches. Id 0
    /// (an empty entry, or an invalid handle) never matches.
    fn slot_of(&self, id: u32) -> Option<usize> {
        if id == 0 {
            return None;
        }
        self.entries.iter().position(|e| e.id() == id)
    }
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
                next_id: 1,
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

    /// Install a loaded app in the first free entry and mint its (never-reused) id. Returns the
    /// handle, or `None` if the table is full OR the id space is exhausted -- both fail closed, and
    /// the refused `val`/`engine` drop after the lock is released. `engine` is kept for
    /// `ee_rt_stop`.
    pub fn insert(&self, val: T, engine: E) -> Option<u32> {
        // `_refused` holds the val+engine of a refused open so they drop AFTER the guard releases,
        // never under the lock.
        let (handle, _refused): (Option<u32>, Option<(T, E)>) = {
            let g = self.lock();
            let free = g.inner.entries.iter().position(|e| matches!(e, Entry::Empty));
            match free {
                // Never mint 0, and never wrap: once the counter has issued u32::MAX it is 0 here
                // and we refuse rather than reuse an id a stale handle might still name.
                Some(i) if g.inner.next_id != 0 => {
                    let id = g.inner.next_id;
                    g.inner.next_id = id.checked_add(1).unwrap_or(0);
                    g.inner.entries[i] = Entry::Loaded { id, val, engine };
                    (Some(id), None)
                }
                _ => (None, Some((val, engine))),
            }
        };
        handle
    }

    /// Check a loaded wasi:http app OUT to serve one request on the caller's thread. The entry
    /// stays (`Busy`) so nothing reuses the id; call `checkin` with the value afterwards. `None`
    /// if the handle does not name a currently-idle loaded app.
    pub fn checkout(&self, handle: u32) -> Option<T> {
        let g = self.lock();
        let i = g.inner.slot_of(handle)?;
        let e = &mut g.inner.entries[i];
        match core::mem::replace(e, Entry::Empty) {
            Entry::Loaded { id, val, engine } => {
                *e = Entry::Busy { id, engine, close_pending: false };
                Some(val)
            }
            other => {
                *e = other;
                None
            }
        }
    }

    /// Return a checked-out app to its entry. If a host close arrived while it was serving, the app
    /// is freed instead of reinstalled (returns `true`, "was closed"). The discarded engine drops
    /// after the lock is released; the value `val` (a parameter) likewise drops after the guard on
    /// the paths where it is not stored back.
    pub fn checkin(&self, handle: u32, val: T) -> bool {
        if handle == 0 {
            return true; // nowhere to put it back; `val` drops here, no lock held
        }
        // `_trash` carries whatever must drop after the guard: on a close/gone path the returned
        // `val` and (if closing) the engine; on the reinstall path nothing (both go back in).
        let (closed, _trash): (bool, Option<(T, Option<E>)>) = {
            let g = self.lock();
            match g.inner.slot_of(handle) {
                Some(i) => {
                    let e = &mut g.inner.entries[i];
                    match core::mem::replace(e, Entry::Empty) {
                        Entry::Busy { id, engine, close_pending } => {
                            if close_pending {
                                (true, Some((val, Some(engine))))
                            } else {
                                *e = Entry::Loaded { id, val, engine };
                                (false, None)
                            }
                        }
                        other => {
                            *e = other; // not a busy app under this id: leave it
                            (true, Some((val, None)))
                        }
                    }
                }
                None => (true, Some((val, None))), // the entry is gone
            }
        };
        closed
    }

    /// Take a loaded wasi:cli app out to run it on the caller's thread, leaving the entry occupied
    /// (`Running`) so nothing reuses the id. Returns the moved value, or `None`.
    pub fn begin_run(&self, handle: u32) -> Option<T> {
        let g = self.lock();
        let i = g.inner.slot_of(handle)?;
        let e = &mut g.inner.entries[i];
        match core::mem::replace(e, Entry::Empty) {
            Entry::Loaded { id, val, engine } => {
                *e = Entry::Running { id, engine };
                Some(val)
            }
            other => {
                *e = other;
                None
            }
        }
    }

    /// The run thread calls this once its app has returned/trapped and its `Store` is dropped.
    /// Clears the entry ONLY if it still holds this exact running occupancy; a handle for an app
    /// that was already freed matches nothing and this is a no-op, so a slow teardown cannot free a
    /// later app. The discarded engine drops after the lock is released. Returns whether it cleared
    /// the entry.
    pub fn finish_run(&self, handle: u32) -> bool {
        // `_trash` holds the discarded engine so it drops after the guard releases.
        let (done, _trash): (bool, Option<E>) = {
            let g = self.lock();
            match g.inner.slot_of(handle) {
                Some(i) => {
                    let e = &mut g.inner.entries[i];
                    match core::mem::replace(e, Entry::Empty) {
                        Entry::Running { engine, .. } => (true, Some(engine)),
                        other => {
                            *e = other;
                            (false, None)
                        }
                    }
                }
                None => (false, None),
            }
        };
        done
    }

    /// A clone of the engine for the app running under this exact handle, for `ee_rt_stop`. `None`
    /// if the handle names no running app -- which is what makes a wrong-tenant stop impossible: a
    /// handle for a stopped/absent app matches no entry, and an id is never reused. The clone is a
    /// `wasmtime::Engine` clone, which is an `Arc` refcount increment (Engine is documented as
    /// cheaply clonable) -- no host call-out, no allocation, no app execution -- so doing it under
    /// the lock keeps the section short.
    pub fn running_engine(&self, handle: u32) -> Option<E> {
        let g = self.lock();
        let i = g.inner.slot_of(handle)?;
        match &g.inner.entries[i] {
            Entry::Running { engine, .. } => Some(engine.clone()),
            _ => None,
        }
    }

    /// Free an entry the host asked to close (wasi:http teardown). Only acts on the app named. An
    /// idle app is taken out (`Took`; drop it outside the lock -- and its engine drops after the
    /// guard here); an app mid-request is marked to free itself on `checkin` (`Deferred`); a
    /// running wasi:cli app or a stale/absent handle is `NotClosable`.
    pub fn remove(&self, handle: u32) -> Removed<T> {
        // The returned value goes to the caller (dropped outside the lock); `_trash` holds the
        // discarded engine so it too drops after the guard releases.
        let (r, _trash): (Removed<T>, Option<E>) = {
            let g = self.lock();
            match g.inner.slot_of(handle) {
                Some(i) => {
                    let e = &mut g.inner.entries[i];
                    match core::mem::replace(e, Entry::Empty) {
                        Entry::Loaded { val, engine, .. } => (Removed::Took(val), Some(engine)),
                        Entry::Busy { id, engine, .. } => {
                            *e = Entry::Busy { id, engine, close_pending: true };
                            (Removed::Deferred, None)
                        }
                        other => {
                            *e = other;
                            (Removed::NotClosable, None)
                        }
                    }
                }
                None => (Removed::NotClosable, None),
            }
        };
        r
    }

    /// True if the handle names an app that is currently running.
    pub fn is_running(&self, handle: u32) -> bool {
        let g = self.lock();
        match g.inner.slot_of(handle) {
            Some(i) => matches!(&g.inner.entries[i], Entry::Running { .. }),
            None => false,
        }
    }

    /// Test-only: drive the id counter near exhaustion without minting billions of handles.
    #[cfg(test)]
    fn set_next_id(&self, id: u32) {
        let g = self.lock();
        g.inner.next_id = id;
    }

    /// Test-only: read the lock flag, so a test can assert a value dropped OUTSIDE the lock.
    #[cfg(test)]
    fn locked(&self) -> bool {
        self.lock.load(Ordering::Relaxed)
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
    fn two_apps_get_distinct_handles() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn a_running_app_keeps_its_entry_so_open_cannot_reuse_its_id() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let val = t.begin_run(a).expect("A begins running");
        assert_eq!(val, "A");
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(a, b, "B gets a fresh id, never A's");
        assert!(t.is_running(a));
    }

    #[test]
    fn a_busy_http_app_keeps_its_entry_too() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let v = t.checkout(a).expect("A checked out for a request");
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(a, b);
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
    fn a_retired_handle_resolves_to_nothing() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        assert!(matches!(t.remove(a), Removed::Took("A")));
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(a, b, "B never reuses A's id");
        assert!(t.checkout(a).is_none());
        assert!(t.begin_run(a).is_none());
        assert!(t.running_engine(a).is_none());
        assert!(matches!(t.remove(a), Removed::NotClosable));
        assert!(!t.finish_run(a));
        assert!(t.checkout(b).is_some(), "B is reachable under its own handle");
    }

    #[test]
    fn a_close_of_a_retired_handle_cannot_free_a_later_app() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        assert!(matches!(t.remove(a), Removed::Took("A")));
        let b = t.insert("B", Eng::new()).unwrap();
        assert!(matches!(t.remove(a), Removed::NotClosable), "closing A's retired handle is a no-op");
        assert!(t.checkout(b).is_some(), "B is still installed");
    }

    #[test]
    fn old_completion_racing_a_new_app_does_not_free_it() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        t.begin_run(a).unwrap();
        assert!(t.finish_run(a)); // A finishes once...
        let b = t.insert("B", Eng::new()).unwrap();
        t.begin_run(b).unwrap();
        assert!(!t.finish_run(a), "A's stale finish is a no-op");
        assert!(t.is_running(b), "B is still running");
    }

    #[test]
    fn a_close_during_a_request_frees_on_checkin() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        let v = t.checkout(a).unwrap();
        assert!(matches!(t.remove(a), Removed::Deferred));
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(a, b);
        assert!(t.checkin(a, v), "checkin reports the app was closed");
        assert!(t.checkout(a).is_none(), "A is gone");
    }

    // The audit's exact scenario, adapted to the monotonic-id design: after the id counter is
    // driven to its boundary, a retired handle must NOT reach a later app.
    #[test]
    fn a_retired_handle_never_reaches_a_later_app_even_near_the_counter_boundary() {
        let t: SlotTable<i32, Eng> = SlotTable::new();
        let old_engine = Eng::new();
        let old = t.insert(1, old_engine.clone()).unwrap();
        assert!(matches!(t.remove(old), Removed::Took(1)));
        // Drive the counter to its last value (would be the wrap point for a bounded field).
        t.set_next_id(u32::MAX);
        let mid = t.insert(2, Eng::new()).unwrap();
        assert_eq!(mid, u32::MAX);
        assert!(matches!(t.remove(mid), Removed::Took(2)));
        // The counter is now exhausted; opening the "new" app must FAIL CLOSED, not reuse `old`.
        assert!(t.insert(3, Eng::new()).is_none(), "id space exhausted -> refuse, never reuse");
        // And the retired handle reaches nothing.
        assert!(t.running_engine(old).is_none());
        assert!(matches!(t.remove(old), Removed::NotClosable));
        // Nothing ever bumped the old engine.
        assert_eq!(old_engine.count(), 0);
    }

    #[test]
    fn exhaustion_fails_closed_and_never_mints_zero_or_a_reused_id() {
        let t: SlotTable<i32, Eng> = SlotTable::new();
        // One before the end: mint u32::MAX, then the counter is exhausted.
        t.set_next_id(u32::MAX);
        let last = t.insert(1, Eng::new()).unwrap();
        assert_eq!(last, u32::MAX);
        // Even with free entries, no more ids are minted.
        assert!(t.insert(2, Eng::new()).is_none());
        assert!(t.insert(3, Eng::new()).is_none());
        // The one live app is still reachable and 0 was never a handle.
        assert!(t.is_running(last) == false && t.checkout(last).is_some());
        assert!(t.checkout(0).is_none());
    }

    #[test]
    fn finish_run_clears_the_entry_for_reuse() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        t.begin_run(a).unwrap();
        assert!(t.is_running(a));
        assert!(t.finish_run(a));
        assert!(!t.is_running(a));
        let b = t.insert("B", Eng::new()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn the_table_fills_and_refuses_a_ninth_app_then_reopens_after_a_free() {
        let t: SlotTable<usize, Eng> = SlotTable::new();
        let mut hs = Vec::new();
        for i in 0..MAX_APPS {
            hs.push(t.insert(i, Eng::new()).expect("slot available"));
        }
        assert!(t.insert(999, Eng::new()).is_none(), "no ninth entry");
        assert!(matches!(t.remove(hs[3]), Removed::Took(_)));
        let n = t.insert(1000, Eng::new()).expect("an entry is free again");
        assert!(!hs.contains(&n), "the new app's id is fresh, not a reused one");
    }

    #[test]
    fn handle_zero_and_unknown_ids_are_never_valid() {
        let t: SlotTable<&str, Eng> = SlotTable::new();
        let a = t.insert("A", Eng::new()).unwrap();
        for bogus in [0u32, a.wrapping_add(1), u32::MAX] {
            if bogus == a { continue; }
            assert!(t.checkout(bogus).is_none());
            assert!(t.begin_run(bogus).is_none());
            assert!(!t.finish_run(bogus));
            assert!(t.running_engine(bogus).is_none());
            assert!(matches!(t.remove(bogus), Removed::NotClosable));
        }
    }

    // Every transition that discards an engine must drop it OUTSIDE the lock. This engine's Drop
    // reads the table's lock flag and panics if it is held, so a drop-under-lock fails the test
    // deterministically (rather than hanging on the non-reentrant spinlock).
    static RT: SlotTable<i32, REng> = SlotTable::new();
    #[derive(Clone)]
    struct REng;
    impl Drop for REng {
        fn drop(&mut self) {
            assert!(!RT.locked(), "an engine was dropped while the table lock was held");
        }
    }

    #[test]
    fn engine_drops_happen_outside_the_lock() {
        // remove(Took): drops the idle app's engine.
        let a = RT.insert(1, REng).unwrap();
        assert!(matches!(RT.remove(a), Removed::Took(_)));
        // finish_run: drops the running app's engine.
        let b = RT.insert(2, REng).unwrap();
        RT.begin_run(b).unwrap();
        let _ = RT.running_engine(b); // clone under lock, dropped here outside
        assert!(RT.finish_run(b));
        // checkin(close_pending): drops the busy app's engine.
        let c = RT.insert(3, REng).unwrap();
        RT.checkout(c).unwrap();
        assert!(matches!(RT.remove(c), Removed::Deferred));
        assert!(RT.checkin(c, 0));
        // insert refused (table full): drops the refused engine.
        let mut live = Vec::new();
        for i in 0..MAX_APPS {
            live.push(RT.insert(i as i32, REng).unwrap());
        }
        assert!(RT.insert(99, REng).is_none()); // refused engine drops outside the lock
        for h in live {
            assert!(matches!(RT.remove(h), Removed::Took(_)));
        }
    }

    #[test]
    fn concurrent_open_run_and_stop_stay_consistent() {
        use std::thread;
        let t: &'static SlotTable<usize, Eng> = Box::leak(Box::new(SlotTable::new()));
        let engs: &'static Vec<Eng> =
            Box::leak(Box::new((0..4).map(|_| Eng::new()).collect()));
        let hs: &'static Vec<u32> = Box::leak(Box::new(
            (0..4).map(|i| t.insert(i, engs[i].clone()).unwrap()).collect(),
        ));
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
                        // Re-open a throwaway app to churn the id counter; ignore exhaustion.
                        let _ = t.insert(9000 + k, engs[k].clone());
                    }
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
