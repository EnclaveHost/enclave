package custody

import (
	"errors"
	"math/big"
	"sort"
)

type share struct {
	x int64
	y *big.Int
}

// lagrange combines exactly the given shares at 0 over the secp256k1 scalar field (custody/threshold.mjs combine).
func lagrange(sh []share) (*big.Int, error) {
	s := new(big.Int)
	for i, a := range sh {
		num, den := big.NewInt(1), big.NewInt(1)
		for j, b := range sh {
			if i == j {
				continue
			}
			if a.x == b.x {
				return nil, errors.New("duplicate share index")
			}
			num.Mod(num.Mul(num, big.NewInt(b.x)), order)
			den.Mod(den.Mul(den, new(big.Int).Mod(big.NewInt(b.x-a.x), order)), order)
		}
		inv := new(big.Int).ModInverse(den, order)
		if inv == nil {
			return nil, errors.New("no inverse")
		}
		term := new(big.Int).Mul(a.y, num)
		term.Mul(term.Mod(term, order), inv)
		s.Add(s, term).Mod(s, order)
	}
	if s.Sign() == 0 {
		return nil, errors.New("combined to zero")
	}
	return s, nil
}

// recoverEnv tries t-subsets of the received shares, in index order, until one opens; at most max attempts.
func recoverEnv(all []share, t, max int, open func(*big.Int) (*Bundle, error)) (*Bundle, int, error) {
	sh := append([]share(nil), all...)
	sort.Slice(sh, func(i, j int) bool { return sh[i].x < sh[j].x })
	idx := make([]int, t)
	for i := range idx {
		idx[i] = i
	}
	tried := 0
	var last error = errors.New("no combination")
	for {
		if tried >= max {
			return nil, tried, last
		}
		pick := make([]share, t)
		for i, k := range idx {
			pick[i] = sh[k]
		}
		tried++
		if s, err := lagrange(pick); err == nil {
			if env, err := open(s); err == nil {
				return env, tried, nil
			} else {
				last = err
			}
		} else {
			last = err
		}
		// next combination (lexicographic)
		i := t - 1
		for i >= 0 && idx[i] == len(sh)-t+i {
			i--
		}
		if i < 0 {
			return nil, tried, last
		}
		idx[i]++
		for j := i + 1; j < t; j++ {
			idx[j] = idx[j-1] + 1
		}
	}
}
