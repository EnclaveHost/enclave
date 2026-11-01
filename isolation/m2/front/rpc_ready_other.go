//go:build !linux || !amd64

package main

import (
	"context"
	"errors"
)

type rpcReadyDelivery struct{}

func readRPCReadyDelivery(*rpcStartApproval) (*rpcReadyDelivery, error) {
	return nil, errors.New("RPC readiness unavailable")
}
func (*rpcReadyDelivery) sample(context.Context, func(context.Context) error) (uint64, error) {
	return 0, errors.New("RPC readiness unavailable")
}
func (*rpcReadyDelivery) publish(uint64) error { return errors.New("RPC readiness unavailable") }
