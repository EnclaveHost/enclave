package contract

import "testing"

// A delete during startup does not change the state (startup still owns the domain), but it IS an end request: a
// caller about to hand the domain something new must see it.
func TestEndRequestedSeesADeleteDuringStartup(t *testing.T) {
	l := NewLifecycle(Starting)
	if l.EndRequested() {
		t.Fatal("a fresh starting domain reports an end request")
	}
	if l.RequestEnd("deleted during startup") || l.State() != Starting {
		t.Fatal("RequestEnd on a starting domain must only record the request")
	}
	if !l.EndRequested() {
		t.Fatal("the recorded request is invisible")
	}
	r := NewLifecycle(Running)
	if r.EndRequested() {
		t.Fatal("a running domain reports an end request")
	}
	r.RequestEnd("lease lapsed")
	if !r.EndRequested() {
		t.Fatal("an ending domain does not report its end")
	}
	f := NewLifecycle(Starting)
	f.FailStart()
	f.Reclaim(nil)
	if !f.EndRequested() {
		t.Fatal("an ended domain does not report its end")
	}
}
