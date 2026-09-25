package contract

import "sync"

// A domain's life has four states, and they exist because startup and reclamation race: a destroy can
// arrive while the domain is still being built, and its process can die during startup. The rules:
//
//   - RequestEnd on a STARTING domain records the request and returns false: startup still owns the
//     domain and will honour the request on its way out (FinishStart returns it).
//   - RequestEnd on a RUNNING domain moves it to ENDING and returns true: the caller reclaims it now.
//   - RequestEnd on an ENDING or ENDED domain returns false: someone else is on it, or it is done.
//   - FinishStart only ever moves STARTING -> RUNNING. It never resurrects an ended domain.
//   - FailStart takes a domain that never got going straight to ENDING.
//   - Reclaim runs its function at most once, however many times and from however many directions
//     it is called, and marks the domain ENDED afterwards.
//
// The backend supplies what reclamation DOES (kill a cgroup, terminate a partition); this type
// supplies WHEN, exactly once.
type State int

const (
	Starting State = iota
	Running
	Ending
	Ended
)

func (s State) String() string {
	switch s {
	case Starting:
		return "starting"
	case Running:
		return "running"
	case Ending:
		return "ending"
	case Ended:
		return "ended"
	}
	return "?"
}

type Lifecycle struct {
	mu        sync.Mutex
	state     State
	endWanted string
	once      sync.Once
	reclaims  int
}

func NewLifecycle(s State) *Lifecycle { return &Lifecycle{state: s} }

func (l *Lifecycle) State() State {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.state
}

// RequestEnd records that the domain should end for `why`. It returns true when the caller should
// reclaim it now, false when startup still owns it or it is already ending or ended.
func (l *Lifecycle) RequestEnd(why string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	switch l.state {
	case Starting:
		if l.endWanted == "" {
			l.endWanted = why
		}
		return false
	case Ending, Ended:
		return false
	}
	l.state = Ending
	return true
}

// EndRequested reports whether an end has been asked for: RequestEnd on a starting domain records it without changing
// the state (startup still owns the domain and honours it on the way out), so a caller deciding whether to hand the
// domain anything NEW - a credential, a connection - asks this as well as State.
func (l *Lifecycle) EndRequested() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.endWanted != "" || l.state == Ending || l.state == Ended
}

// FinishStart moves a starting domain to running and returns the reason a reclamation asked for
// while startup held it, or "".
func (l *Lifecycle) FinishStart() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state == Starting {
		l.state = Running
	}
	return l.endWanted
}

// FailStart takes a domain that never got going straight to ending.
func (l *Lifecycle) FailStart() {
	l.mu.Lock()
	l.state = Ending
	l.mu.Unlock()
}

// Reclaim runs f exactly once over the life of the domain and then marks it ended.
func (l *Lifecycle) Reclaim(f func()) {
	l.once.Do(func() {
		l.mu.Lock()
		l.reclaims++
		l.mu.Unlock()
		if f != nil {
			f()
		}
		l.mu.Lock()
		l.state = Ended
		l.mu.Unlock()
	})
}

// Reclaims is how many times reclamation actually ran: 0 or 1.
func (l *Lifecycle) Reclaims() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.reclaims
}
