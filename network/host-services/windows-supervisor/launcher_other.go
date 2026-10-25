//go:build !windows

package main

import (
	"errors"
	"log"
)

// Only Windows has the Job Object launcher; elsewhere the systemd unit is the supervisor.
type unsupported struct{}

func (unsupported) Start(*Config) (Process, error) {
	return nil, errors.New("hostsvc-supervisor runs only on Windows")
}
func newLauncher(*log.Logger) Launcher { return unsupported{} }
func stopChannel(string) (<-chan struct{}, error) {
	return nil, errors.New("hostsvc-supervisor runs only on Windows")
}
func signalStop(string) error { return errors.New("hostsvc-supervisor runs only on Windows") }
