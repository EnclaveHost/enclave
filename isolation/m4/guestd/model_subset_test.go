package main

import (
	"enclave.host/isolation/contract"
	"reflect"
	"testing"
)

func TestShieldModelSubset(t *testing.T) {
	for _, marker := range []string{contract.Shield27BModel + "\n", contract.ShieldModel + "\n" + contract.Shield27BModel + "\n"} {
		if _, err := parseShieldModels(marker); err != nil {
			t.Fatal(err)
		}
	}
	for _, marker := range []string{"", "unknown", contract.Shield27BModel + "\n" + contract.Shield27BModel} {
		if _, err := parseShieldModels(marker); err == nil {
			t.Fatalf("accepted invalid marker %q", marker)
		}
	}
	s := newServer(newFake(), t.TempDir())
	s.ShieldEnabled = true
	s.ShieldModels = []string{contract.Shield27BModel}
	for _, model := range []string{contract.ShieldModel, contract.Shield27BModel} {
		m := contract.Manifest{Inference: &contract.Inference{Model: model, GPUMilli: 800}}
		why := s.inferenceRefusal(&Request{GPUShare: .8}, m, false)
		if (why == "") != (model == contract.Shield27BModel) {
			t.Fatalf("wrong admission for %s: %s", model, why)
		}
	}
	volumes := s.inferenceVolumes()
	if len(volumes) != 1 || volumes[0]["name"] != contract.Shield27BModel {
		t.Fatalf("advertised unavailable model: %v", volumes)
	}
	h := s.inferenceHealthLocked().(map[string]any)
	if !reflect.DeepEqual(h["models"], s.ShieldModels) || h["model"] != contract.ShieldModel {
		t.Fatalf("wrong model health: %v", h)
	}
}
