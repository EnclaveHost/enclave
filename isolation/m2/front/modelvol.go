package main

// modelvol.go: the deployment's MODEL VOLUMES, as the front hands them to init (dominit.c, modelvol.h).
//
// The config the release (or the owner-committed bootstrap) delivered names the volumes the app runs with - the
// catalog's "volumes" list, read exactly as wasm/wasm_manager.py reads it: a JSON list, each entry str()-ed and
// stripped, empties dropped, repeats dropped. Each name must be in this image's measured table (/rt/model-volumes.table,
// pinned when the release was built). The front checks that before the app's start and tells init the names in one
// "M1" block; init looks the identities up in the same table, finds each disk by its root-derived serial, and mounts
// it read-only over dm-verity against the pinned root. Nothing the host says decides which bytes a name means.
//
// Refused, never dropped: a config naming volumes on an image without the table, a name the table lacks, more than
// init mounts (8), and model volumes on a Shield inference image (which carries its own measured model).

import (
	"errors"
	"fmt"
	"os"

	"enclave.host/isolation/m2/modelspec"
)

const modelTablePath = "/rt/model-volumes.table"

// configVolumes is wasm_manager's reading of the config's "volumes" (modelspec.ConfigVolumes).
func configVolumes(config string) []string { return modelspec.ConfigVolumes(config) }

// modelBlock -> init's "M1" block for config, or nil without model volumes.
func modelBlock(config, table string, shieldImage bool) ([]byte, error) {
	vols := configVolumes(config)
	if len(vols) == 0 {
		return nil, nil
	}
	if shieldImage {
		return nil, errors.New("the config names model volumes, and a Shield inference image carries its own measured model: the app is not started without its volumes")
	}
	if len(vols) > modelspec.Max {
		return nil, fmt.Errorf("the config names %d model volumes; a per-app guest mounts at most %d", len(vols), modelspec.Max)
	}
	names, err := modelspec.ReadTable(table)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("the config names model volumes, and this image carries no model-volume table: the app is not started without its volumes")
		}
		return nil, errors.New("the measured model-volume table is malformed")
	}
	for _, v := range vols {
		if _, ok := names[v]; !ok || !modelspec.NameRE.MatchString(v) {
			return nil, fmt.Errorf("model volume %q is not one this image's measured table carries: the app is not started without it", v)
		}
	}
	return modelspec.M1(vols), nil
}

// shieldImage: a Shield inference image (its measured profile, dominit's shield_profile).
func shieldImage() bool {
	_, err := os.Stat("/app.shield")
	return err == nil
}

// handToInitBlocks is handToInitMode plus init's trailer blocks after the config's NUL, NUL-separated (dominit.c
// front_blocks): the encrypted volumes' "E1" (encvol.go) and the model volumes' "M1". Empty blocks are left out; no
// block without a config. The message is wiped once written.
func handToInitBlocks(w *os.File, config string, publicHTTPS bool, blocks ...[]byte) error {
	var keep [][]byte
	for _, b := range blocks {
		if len(b) > 0 {
			keep = append(keep, b)
		}
	}
	if len(keep) == 0 {
		return handToInitMode(w, config, publicHTTPS)
	}
	defer w.Close()
	if config == "" {
		return errors.New("init trailer blocks without a config")
	}
	tag := byte('C')
	if publicHTTPS {
		tag = 'P'
	}
	msg := []byte{tag}
	msg = append(msg, config...)
	for _, b := range keep {
		msg = append(msg, 0)
		msg = append(msg, b...)
	}
	_, err := w.Write(msg)
	for i := range msg {
		msg[i] = 0
	}
	return err
}
