package main

import (
	"github.com/nknorg/nkn/v2/common"
	"testing"
)

func TestRefillNeeded(t *testing.T) {
	for _, c := range []struct {
		balance, target, low common.Fixed64
		want                 bool
	}{
		{4, 25, 10, true}, {10, 25, 10, false}, {24, 25, 10, false},
		{25, 25, 10, false}, {30, 25, 10, false}, {24, 25, 0, true},
		{4, 5, 10, true}, {5, 5, 10, false},
	} {
		if got := refillNeeded(c.balance, c.target, c.low); got != c.want {
			t.Errorf("balance=%d target=%d low=%d: got %v want %v", c.balance, c.target, c.low, got, c.want)
		}
	}
}
