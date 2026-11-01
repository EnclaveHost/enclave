package main

// The M4b report source: the SVSM computes the binding, and this domain cannot choose it.
//
// WHAT IS DIFFERENT FROM THE OTHER TWO SOURCES. On the M2 path the front builds report_data itself; on the M3
// path it builds the binding and a monitor writes the app half. Both leave the binding to guest code, and on the
// IGVM path the guest image is outside the launch measurement, so that code's identity is not what the report
// establishes. Here the front REGISTERS its transport key once and afterwards sends only a nonce: the SVSM
// computes report_data[0:32] = Bind2(registered key, nonce, its own compiled-in RuntimeID) and fills
// report_data[32:64] from APP_TABLE indexed by the CALLING PLANE. Neither half is a field of the request, so
// this process cannot name a different app, a different runtime, or a different key than the one it registered.
//
// The key is registered ONCE per admission and is forgotten when the plane is reclaimed, which is why a
// registration failure here is fatal rather than retried: a front that served reports bound to no key, or to a
// key some earlier admission registered, would be worse than one that did not start.

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// appidPlane talks to the guest module that carries the SVSM's appid protocol. One at a time: the module's
// report buffer and nonce are single global slots, so two concurrent attestations would interleave and each
// could return the other's bytes.
type appidPlane struct {
	dir string
	mu  sync.Mutex
}

// the SVSM's SnpReportResponse header: status(4) + report_size(4) + reserved(24)
const appidRespHeader = 32

func (a *appidPlane) write(attr, val string) error {
	p := filepath.Join(a.dir, attr)
	f, err := os.OpenFile(p, os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("%s: %w", p, err)
	}
	defer f.Close()
	// One write, and the whole value must land. kernfs caps a sysfs write at PAGE_SIZE and returns the
	// TRUNCATED length with no error, so a short count is a real failure and not something to loop over.
	n, err := f.Write([]byte(val))
	if err != nil {
		return fmt.Errorf("%s: %w", p, err)
	}
	if n != len(val) {
		return fmt.Errorf("%s: wrote %d of %d bytes (sysfs truncates at PAGE_SIZE)", p, n, len(val))
	}
	return nil
}

func (a *appidPlane) read(attr string) (string, error) {
	b, err := os.ReadFile(filepath.Join(a.dir, attr))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// registerKey hands the SVSM this domain's transport key. Once, at startup, before any report is served.
func (a *appidPlane) registerKey(spki []byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.write("key", hex.EncodeToString(spki)); err != nil {
		return fmt.Errorf("registering the transport key: %w", err)
	}
	// Read it back. The SVSM stores the key it will bind, so this is the one chance to see that what it holds
	// is what this process minted - and a report bound to a different key would verify against a handshake
	// this domain cannot perform.
	got, err := a.read("key")
	if err != nil {
		return fmt.Errorf("reading back the registered key: %w", err)
	}
	if !strings.EqualFold(got, hex.EncodeToString(spki)) {
		return fmt.Errorf("the SVSM holds a different transport key than this domain minted: %.32s... vs %.32s...",
			got, hex.EncodeToString(spki))
	}
	return nil
}

// report asks the SVSM for a report over this nonce. The binding is not a parameter.
func (a *appidPlane) report(nonce []byte) ([]byte, error) {
	if len(nonce) != 32 {
		return nil, errors.New("nonce must be 32 bytes")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.write("bind", hex.EncodeToString(nonce)); err != nil {
		return nil, fmt.Errorf("setting the nonce: %w", err)
	}
	if err := a.write("report", "1"); err != nil {
		return nil, fmt.Errorf("asking the SVSM for a report: %w", err)
	}
	h, err := a.read("report")
	if err != nil {
		return nil, fmt.Errorf("reading the report: %w", err)
	}
	raw, err := hex.DecodeString(h)
	if err != nil {
		return nil, fmt.Errorf("the module published unparseable hex: %w", err)
	}
	if len(raw) < appidRespHeader+8 {
		return nil, fmt.Errorf("%d bytes is too short for a response header", len(raw))
	}
	status := uint32(raw[0]) | uint32(raw[1])<<8 | uint32(raw[2])<<16 | uint32(raw[3])<<24
	size := uint32(raw[4]) | uint32(raw[5])<<8 | uint32(raw[6])<<16 | uint32(raw[7])<<24
	if status != 0 {
		return nil, fmt.Errorf("the SVSM refused: status %d", status)
	}
	if int(size)+appidRespHeader > len(raw) {
		// The module publishes hex through sysfs, which is bounded by PAGE_SIZE, so a long response is
		// TRUNCATED rather than reported. A report cut before its signature at 0x2a0 would fail verification
		// for a reason that has nothing to do with this domain, so say what happened instead.
		return nil, fmt.Errorf("the response says %d bytes but only %d were published: the module's sysfs "+
			"output is truncated at PAGE_SIZE", size, len(raw)-appidRespHeader)
	}
	rep := raw[appidRespHeader : appidRespHeader+int(size)]
	if len(rep) < 0x2a0+0x90 {
		return nil, fmt.Errorf("%d report bytes: too few to contain the signature at 0x2a0", len(rep))
	}
	return rep, nil
}
