//go:build releaselab

package release

// LAB pins (-tags releaselab; isolation/m2/lab-release/run-lab.sh): a lab relay name, a lab CA generated for the run,
// and that run's lab release key. A front built with them is a lab image: its measurement differs from every
// production image, and its relay name resolves nowhere public, so it can only ever talk to a lab relay. The files
// under labpins/ are written by run-lab.sh and never committed.

import (
	_ "embed"
	"strings"
)

const RelayHost = "release-lab.enclave.test"

//go:embed labpins/ca.pem
var labCA []byte

//go:embed labpins/release-key.hex
var labReleaseKey string

var embeddedRoots = [][]byte{labCA}

// RootFingerprints: a lab CA is generated per run, so it is pinned by being the ONLY root embedded.
var RootFingerprints []string

var relayReleaseKeys = []string{strings.TrimSpace(labReleaseKey)}
