// Package seats is the custody v2 seat layout (docs/security/secret-custody-v2.md §6.1-6.2; custody/v2/protocol.mjs
// seatLayout is the reference). It is integer logic only, with no dependencies, so the release package can check a
// pointer's claimed threshold and share indices without linking the curve code.
//
// All Enclave-owned machines are ONE seat holding the same share(s); every other machine is its own seat. n = seats.
// n >= 3: weight 1 each, t = ceil(2n/3). n < 3: an Enclave seat is required; t = (other seats) + 1, the Enclave seat
// holds t shares, the others 1. Indices: the Enclave seat first (1..wE), then the others in machine order.
package seats

import (
	"errors"
	"fmt"
)

const (
	// MaxSeats bounds a committee's seats (and so its share indices, at most 2*MaxSeats).
	MaxSeats = 64
	// MaxMachines bounds a committee's machines (seats + Enclave replicas).
	MaxMachines = 96
)

// Layout is the seat layout of one machine list.
type Layout struct {
	N, T, W int
	// EnclaveWeight is the number of shares the Enclave seat holds (0 = no Enclave seat).
	EnclaveWeight int
	// EnclaveIndices are the Enclave seat's share indices (1..EnclaveWeight), nil without an Enclave seat.
	EnclaveIndices []uint32
	// Indices[i] are machine i's share indices.
	Indices [][]uint32
}

// Of lays out the seats of a machine list given each machine's Enclave flag, in machine order.
func Of(enclave []bool) (*Layout, error) {
	if len(enclave) == 0 || len(enclave) > MaxMachines {
		return nil, fmt.Errorf("seats: 1..%d machines", MaxMachines)
	}
	nEnc, others := 0, 0
	for _, e := range enclave {
		if e {
			nEnc++
		} else {
			others++
		}
	}
	n := others
	if nEnc > 0 {
		n++
	}
	if n > MaxSeats {
		return nil, fmt.Errorf("seats: at most %d", MaxSeats)
	}
	l := &Layout{N: n, Indices: make([][]uint32, len(enclave))}
	wE := 0
	if n >= 3 {
		l.T, wE = (2*n+2)/3, 1
	} else {
		if nEnc == 0 {
			return nil, errors.New("seats: fewer than 3 seats needs the Enclave seat")
		}
		l.T = others + 1
		wE = l.T
	}
	next := uint32(1)
	if nEnc > 0 {
		l.EnclaveWeight = wE
		for j := 0; j < wE; j++ {
			l.EnclaveIndices = append(l.EnclaveIndices, next)
			next++
		}
		for i, e := range enclave {
			if e {
				l.Indices[i] = append([]uint32(nil), l.EnclaveIndices...)
			}
		}
	}
	for i, e := range enclave {
		if !e {
			l.Indices[i] = []uint32{next}
			next++
		}
	}
	l.W = int(next) - 1
	return l, nil
}
