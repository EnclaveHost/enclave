package main

import (
	"enclave.host/isolation/contract"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestInferenceAllocationAndAdmission(t *testing.T) {
	s := newServer(newFake(), t.TempDir())
	s.ShieldEnabled = true
	inf := &contract.Inference{Model: contract.ShieldModel, GPUMilli: 100}
	m := contract.Manifest{Inference: inf}
	for _, share := range []float64{0, .09, .11, 1.1} {
		if s.inferenceRefusal(&Request{GPUShare: share}, m, false) == "" {
			t.Fatal("accepted mismatching share", share)
		}
	}
	if why := s.inferenceRefusal(&Request{GPUShare: .1}, m, false); why != "" {
		t.Fatal(why)
	}
	if s.inferenceRefusal(&Request{GPUShare: .1}, m, true) == "" {
		t.Fatal("legacy admitted")
	}
	s.ShieldEnabled = false
	if s.inferenceRefusal(&Request{GPUShare: .1}, m, false) == "" {
		t.Fatal("disabled admitted")
	}
	s.ShieldEnabled = true
	s.vms["first"] = &vm{GPUCardBytes: inf.CardBytes()}
	if s.gpuAllocatedLocked() != inf.CardBytes() {
		t.Fatal("missing reservation")
	}
	if s.gpuAdmitLocked(contract.ShieldCardBytes) == nil {
		t.Fatal("overcommitted")
	}
	s.vms["first"].reclaimed = true
	if s.gpuAdmitLocked(contract.ShieldCardBytes) != nil {
		t.Fatal("reservation not released")
	}
	// Recovery may exceed a reduced budget: keep running guests, refuse new work.
	s.vms["recovered"] = &vm{GPUCardBytes: contract.ShieldCardBytes + 1}
	if s.gpuAdmitLocked(1) == nil {
		t.Fatal("admitted while overcommitted")
	}
}

func TestConcurrentInferenceCreateReservesBeforeLaunch(t *testing.T) {
	r := newRig(t)
	r.s.ShieldEnabled = true
	r.s.ShieldReleases = []string{"shield-release"}
	b, err := contract.Build(contract.Manifest{Label: "model", Inference: &contract.Inference{Model: contract.ShieldModel, GPUMilli: 600}}, []byte("\x00asm component"))
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(r.dir, "model.bundle")
	if err = os.WriteFile(file, b, 0600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = r.do("POST", "/vms", map[string]any{"name": name(i + 1), "image": "file://" + file, "gpuShare": 0.6})
		}(i)
	}
	wg.Wait()
	if !((codes[0] == 201 && codes[1] == 507) || (codes[1] == 201 && codes[0] == 507)) {
		t.Fatalf("concurrent GPU admission: %v", codes)
	}
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	if len(r.s.vms) != 1 {
		t.Fatalf("refused request left a guest: %d", len(r.s.vms))
	}
	for _, v := range r.s.vms {
		if v.MemMiB != 8192 {
			t.Fatalf("model RAM floor: %d", v.MemMiB)
		}
	}
}

func Test27BReservesPrivateModelMemoryAndBothCards(t *testing.T) {
	r := newRig(t)
	r.s.ShieldEnabled = true
	r.s.ShieldReleases = []string{"shield-release"}
	inf := &contract.Inference{Model: contract.Shield27BModel, GPUMilli: 500}
	b, err := contract.Build(contract.Manifest{Label: "27b", Inference: inf,
		Policy: contract.Policy{CPUPercent: 800, Vcpus: 8, MemMiB: 50816}}, []byte("\x00asm component"))
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(r.dir, "27b.bundle")
	if err = os.WriteFile(file, b, 0600); err != nil {
		t.Fatal(err)
	}
	code, body := r.do("POST", "/vms", map[string]any{"name": name(9), "image": "file://" + file, "gpuShare": .5})
	if code != 201 {
		t.Fatalf("%d %v", code, body)
	}
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	for _, v := range r.s.vms {
		if v.MemMiB != 51200 || v.Vcpus != 8 || v.GPUCardBytes != inf.CardBytes() {
			t.Fatalf("incorrect 27B reservation: %+v", v)
		}
	}
}
