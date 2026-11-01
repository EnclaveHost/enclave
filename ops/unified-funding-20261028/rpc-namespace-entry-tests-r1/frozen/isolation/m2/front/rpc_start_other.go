//go:build !linux

package main

import "errors"

type rpcStartApproval struct{}

func readRPCStartApproval([]byte, [32]byte, [32]byte) (*rpcStartApproval, error) {
	return nil, errors.New("RPC start requires Linux inherited capabilities")
}
func (*rpcStartApproval) approve() error { return errors.New("RPC start unavailable") }
