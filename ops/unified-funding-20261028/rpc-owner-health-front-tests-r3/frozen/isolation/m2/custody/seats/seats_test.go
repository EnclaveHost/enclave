package seats

import (
	"reflect"
	"testing"
)

func TestThresholds(t *testing.T) {
	for _, c := range []struct {
		enclave []bool
		n, t, w int
		idx     [][]uint32
	}{
		{[]bool{true}, 1, 1, 1, [][]uint32{{1}}},
		{[]bool{true, false}, 2, 2, 3, [][]uint32{{1, 2}, {3}}},
		{[]bool{false, true}, 2, 2, 3, [][]uint32{{3}, {1, 2}}},
		{[]bool{false, false, false}, 3, 2, 3, [][]uint32{{1}, {2}, {3}}},
		{[]bool{false, false, false, false}, 4, 3, 4, [][]uint32{{1}, {2}, {3}, {4}}},
		{[]bool{true, false, false, false, false, false}, 6, 4, 6, [][]uint32{{1}, {2}, {3}, {4}, {5}, {6}}},
	} {
		l, err := Of(c.enclave)
		if err != nil || l.N != c.n || l.T != c.t || l.W != c.w || !reflect.DeepEqual(l.Indices, c.idx) {
			t.Fatalf("%v: %+v %v", c.enclave, l, err)
		}
	}
	for _, bad := range [][]bool{nil, {false}, {false, false}, make([]bool, MaxMachines+1)} {
		if _, err := Of(bad); err == nil {
			t.Fatalf("%v accepted", bad)
		}
	}
	// 65 non-Enclave seats: over the seat limit
	if _, err := Of(make([]bool, MaxSeats+1)); err == nil {
		t.Fatal("65 seats accepted")
	}
}
