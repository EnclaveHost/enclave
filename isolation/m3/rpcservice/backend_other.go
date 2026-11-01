//go:build !(linux && amd64)

package rpcservice

import "errors"

func openBackend(Groups) (backend, error) {
	return nil, errors.New("rpcservice: requires the linux/amd64 cgroup v2 backend")
}
