//! The set of host socket handles an app currently holds, so they are all closed exactly once when
//! the app goes away -- including when it TRAPS.
//!
//! The leak this fixes (nucbox-k11, 2026-09-25): a wasi:cli app that traps has its `Store` dropped
//! by `ee_rt_run`, but dropping a `Store`/`ResourceTable` runs each resource's Rust destructor, NOT
//! the WIT `tcp-socket.drop` method that actually calls `ee_net_close`. So the app's LISTENER was
//! never closed on a trap: the host kept the port bound by a dead app (observed as listener handle
//! 7 still held after the instance was replaced), and because the host also bound with
//! SO_REUSEADDR the relaunch bound the SAME port beside the corpse and every new connection went to
//! the dead listener -- a port that accepts and never answers.
//!
//! `WasiState` owns one of these. Every listen/accept/connect records its handle; the WIT
//! `tcp-socket.drop` removes-and-closes when the GUEST drops a socket; and `WasiState`'s own
//! `Drop` closes whatever is still open when the store is torn down for any reason. `remove`
//! returning whether the handle was present is what keeps the two paths from double-closing: a
//! handle the guest already closed is gone from the set, so teardown does not touch it, and a
//! handle the guest never closed is closed once, by teardown.

use alloc::vec::Vec;

pub struct SocketSet {
    open: Vec<i32>,
}

impl SocketSet {
    pub const fn new() -> Self {
        SocketSet { open: Vec::new() }
    }

    /// Record a handle this app now owns. Handles <= 0 are not real sockets (they are the error
    /// returns of the brokered calls) and are ignored, so a failed listen/accept/connect never
    /// enters the set.
    pub fn add(&mut self, handle: i32) {
        if handle > 0 && !self.open.contains(&handle) {
            self.open.push(handle);
        }
    }

    /// Remove a handle the guest is closing itself. Returns whether it was still open here -- the
    /// caller closes the host socket only when this is `true`, so a handle is closed exactly once.
    pub fn remove(&mut self, handle: i32) -> bool {
        if let Some(i) = self.open.iter().position(|&h| h == handle) {
            self.open.swap_remove(i);
            true
        } else {
            false
        }
    }

    /// Take every still-open handle, for teardown to close. The set is left empty, so a second
    /// teardown (or a late guest drop) closes nothing.
    pub fn drain(&mut self) -> Vec<i32> {
        core::mem::take(&mut self.open)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.open.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A stand-in for ee_net_close that records every handle it is asked to close, so a test can
    // assert each handle is closed exactly once.
    fn run(script: impl FnOnce(&mut SocketSet, &mut dyn FnMut(i32))) -> Vec<i32> {
        let mut closed = Vec::new();
        let mut set = SocketSet::new();
        {
            let mut close = |h: i32| closed.push(h);
            script(&mut set, &mut close);
        }
        // teardown: close whatever is left
        for h in set.drain() {
            closed.push(h);
        }
        closed
    }

    #[test]
    fn a_listener_left_open_by_a_trap_is_closed_by_teardown() {
        // The reported case: listen, accept a couple, never drop them (the app trapped), teardown.
        let closed = run(|set, _close| {
            set.add(7); // the listener
            set.add(10);
            set.add(11);
        });
        let mut c = closed.clone();
        c.sort();
        assert_eq!(c, vec![7, 10, 11], "every held socket, including the listener, is closed once");
    }

    #[test]
    fn a_socket_the_guest_closed_is_not_closed_again_by_teardown() {
        let closed = run(|set, close| {
            set.add(7);
            set.add(10);
            // guest drops socket 10: closed once here...
            if set.remove(10) {
                close(10);
            }
        });
        // ...and teardown closes only 7. 10 appears exactly once total.
        assert_eq!(closed.iter().filter(|&&h| h == 10).count(), 1, "10 closed exactly once");
        assert_eq!(closed.iter().filter(|&&h| h == 7).count(), 1, "7 closed once by teardown");
        assert_eq!(closed.len(), 2);
    }

    #[test]
    fn dropping_an_untracked_handle_closes_nothing() {
        let mut set = SocketSet::new();
        set.add(3);
        assert!(!set.remove(99), "99 was never ours");
        assert!(set.remove(3));
        assert_eq!(set.len(), 0);
    }

    #[test]
    fn failed_calls_never_enter_the_set() {
        let mut set = SocketSet::new();
        set.add(-11); // EAGAIN from a broker call
        set.add(0);
        set.add(-9);
        assert_eq!(set.len(), 0);
        set.add(5);
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn add_is_idempotent_so_a_handle_is_tracked_once() {
        let mut set = SocketSet::new();
        set.add(5);
        set.add(5);
        assert_eq!(set.len(), 1);
        assert!(set.remove(5));
        assert!(!set.remove(5), "one add, one remove");
    }

    #[test]
    fn drain_leaves_the_set_empty_so_a_second_teardown_is_a_noop() {
        let mut set = SocketSet::new();
        set.add(1);
        set.add(2);
        assert_eq!(set.drain(), vec![1, 2]);
        assert!(set.drain().is_empty(), "nothing to close a second time");
    }
}
