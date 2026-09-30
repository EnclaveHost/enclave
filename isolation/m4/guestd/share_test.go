package main

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	"enclave.host/isolation/contract"
)

func TestMemoryShareLimits(t *testing.T) {
	s := server{Budget: poolBudget{MemMiB: 65536, CPUPct: 1600}}
	for _, share := range []float64{0, -1, 1.01, math.NaN(), math.Inf(1)} {
		if s.memoryShareRefusal(share, 128, 1024) == nil {
			t.Fatalf("invalid share accepted: %v", share)
		}
	}
	if r := s.memoryShareRefusal(.07, 50816, 73728); r == nil || r["allowedMiB"] != 4587 || r["requiredMiB"] != 73344 {
		t.Fatalf("27B floor bypassed the share: %v", r)
	}
	if s.memoryShareRefusal(1, 50816, 73728) == nil {
		t.Fatal("oversized model admitted at 100% on 64 GiB pool")
	}
	if r := s.memoryShareRefusal(.01, 128, 1024); r != nil {
		t.Fatalf("charged kernel boot floor to app: %v", r)
	}
	if r := s.memoryShareRefusal(.07, 4587, 4587+384); r != nil {
		t.Fatalf("boundary should fit: %v", r)
	}
	if s.memoryShareRefusal(.07, 4588, 4588+384) == nil {
		t.Fatal("rounded beyond entitlement")
	}
	s.Budget.MemMiB = 90112
	if s.memoryShareRefusal(.81, 50816, 73728) == nil {
		t.Fatal("81% underfunded model accepted")
	}
	if r := s.memoryShareRefusal(.82, 50816, 73728); r != nil {
		t.Fatalf("82%% should fit 88 GiB host: %v", r)
	}
}

func TestUnderSharedInferenceNeverCreatesOrAdopts(t *testing.T) {
	r := newRig(t)
	r.s.ShieldEnabled = true
	r.s.ShieldReleases = []string{"shield-release"}
	r.s.Budget = poolBudget{MemMiB: 90112, CPUPct: 2400}
	b, err := contract.Build(contract.Manifest{Label: "share-test", Inference: &contract.Inference{Model: contract.Shield27BModel, GPUMilli: 500},
		Policy: contract.Policy{CPUPercent: 1600, Vcpus: 16, MemMiB: 50816}}, []byte("\x00asm component"))
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(r.dir, "share.bundle")
	if err := os.WriteFile(p, b, 0600); err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"name": name(89), "image": "file://" + p, "gpuShare": .5, "cpuShare": .07}
	code, body := r.do("POST", "/vms", request)
	if code != 422 || body["error"] != "ram_share_too_small" {
		t.Fatalf("under-share create: %d %v", code, body)
	}
	if r.f.builds != 0 || len(r.s.vms) != 0 {
		t.Fatal("refusal allocated a guest")
	}
	request["cpuShare"] = .82
	if code, body = r.do("POST", "/vms", request); code != 201 {
		t.Fatalf("funded create: %d %v", code, body)
	}
	request["cpuShare"] = .07
	if code, body = r.do("POST", "/vms", request); code != 422 {
		t.Fatalf("duplicate-name bypass: %d %v", code, body)
	}
}

func TestShareBoundedModelKeepsAppRunning(t *testing.T) {
	r := newRig(t)
	r.s.ShieldEnabled = true
	r.s.ShieldShareMemory = true
	r.s.ShieldReleases = []string{"bounded-shield"}
	r.s.Budget = poolBudget{MemMiB: 90112, CPUPct: 2400}
	b, err := contract.Build(contract.Manifest{Label: "bounded-app", Inference: &contract.Inference{Model: contract.Shield27BModel, GPUMilli: 500}, Policy: contract.Policy{CPUPercent: 1600, Vcpus: 16, MemMiB: 50816}}, []byte("\x00asm component"))
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(r.dir, "bounded.bundle")
	if err := os.WriteFile(p, b, 0600); err != nil {
		t.Fatal(err)
	}
	code, body := r.do("POST", "/vms", map[string]any{"name": name(90), "image": "file://" + p, "gpuShare": .5, "cpuShare": .07})
	if code != 201 {
		t.Fatalf("app should boot: %d %v", code, body)
	}
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	for _, v := range r.s.vms {
		if v.MemMiB != 6691 {
			t.Fatalf("guest memory %d exceeds 6307 MiB plus 384 MiB overhead", v.MemMiB)
		}
	}
}
