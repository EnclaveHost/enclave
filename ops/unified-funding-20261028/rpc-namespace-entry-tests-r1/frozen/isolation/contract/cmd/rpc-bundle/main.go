// rpc-bundle prepares an exclusive, offline RPC app bundle. It never registers,
// funds, launches or attests an app. All identifiers must come from the owner.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/contract/catalog"
)

func read(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > limit {
		return nil, errors.New("bounded regular input required")
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("input grew beyond limit")
	}
	return b, nil
}

func write(path string, b []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(b); err != nil {
		return err
	}
	return f.Sync()
}

func prepare(record, component, out string) error {
	raw, err := read(record, contract.MaxManifestBytes)
	if err != nil {
		return err
	}
	d, err := catalog.ParseRPCRecord(raw)
	if err != nil {
		return err
	}
	c, err := read(component, contract.MaxRPCControllerBytes)
	if err != nil {
		return err
	}
	m, b, err := catalog.MapRPC(d, c)
	if err != nil {
		return err
	}
	if _, _, err = contract.ParseRPC(b); err != nil {
		return err
	}
	if err = os.Mkdir(out, 0700); err != nil {
		return err
	} // Partial output stays held.
	if err = write(filepath.Join(out, "app.bundle"), b); err != nil {
		return err
	}
	canonical, err := contract.Canonical(d)
	if err != nil {
		return err
	}
	if err = write(filepath.Join(out, "record.json"), append(canonical, '\n')); err != nil {
		return err
	}
	receipt, err := json.MarshalIndent(struct {
		Mapping catalog.RPCMapping `json:"mapping"`
		Status  string             `json:"status"`
	}{m, "offline-candidate-not-runtime-admitted"}, "", "  ")
	if err != nil {
		return err
	}
	if err = write(filepath.Join(out, "mapping.json"), append(receipt, '\n')); err != nil {
		return err
	}
	f, err := os.Open(out)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = f.Sync(); err != nil {
		return err
	}
	parent, err := os.Open(filepath.Dir(out))
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func main() {
	r := flag.String("record", "", "owner-selected RPC derivation record")
	c := flag.String("component", "", "portable RPC controller component")
	o := flag.String("out", "", "new exclusive output directory")
	flag.Parse()
	if *r == "" || *c == "" || *o == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: rpc-bundle -record RECORD -component WASM -out NEW_DIRECTORY")
		os.Exit(2)
	}
	if err := prepare(*r, *c, *o); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
