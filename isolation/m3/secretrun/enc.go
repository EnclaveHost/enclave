package main

// Encrypted volumes in a partition domain (isolation/m2/encvol): the front, after the release and egress, started the
// plane and put three reserved names on this pipe. They are believed only as far as the MONITOR's staging agrees: every
// name must be one the monitor staged (its root-owned, read-only /enc.volumes, from the measured config), each staged
// volume must be named, each /enc/<name> must be a real directory, the URL must be this domain's loopback plane for
// a 32-byte deployment id, and the token 192 bits of hex - the same rules init applies on an SNP guest (m2/dominit.c
// enc_trailer).

import (
	"errors"
	"os"
	"regexp"
	"strings"
	"syscall"
)

const (
	encMarker = "/enc.volumes"
	encRoot   = "/enc"
)

// markerOwner is root in a domain; a test sets its own uid.
var markerOwner uint32 = 0

type encLaunch struct {
	names      []string
	api, token string
}

var (
	encNameRE  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	encAPIRE   = regexp.MustCompile(`^http://127\.0\.0\.1:[0-9]{1,5}/encvol/0x[0-9a-f]{64}$`)
	encTokenRE = regexp.MustCompile(`^[0-9a-f]{48}$`)
)

// takeEnc removes ENCLAVE_ENC, ENCLAVE_ENC_API and ENCLAVE_ENC_TOKEN from m and judges them against the monitor's
// staging (marker, root). None of the three and no staging: no volumes. Anything else is a refusal: the runtime never
// starts with volumes the monitor did not stage, nor without ones it did.
func takeEnc(m map[string]string, marker, root string) (encLaunch, error) {
	names, hasN := m["ENCLAVE_ENC"]
	api, hasA := m["ENCLAVE_ENC_API"]
	token, hasT := m["ENCLAVE_ENC_TOKEN"]
	delete(m, "ENCLAVE_ENC")
	delete(m, "ENCLAVE_ENC_API")
	delete(m, "ENCLAVE_ENC_TOKEN")
	staged, err := readStaged(marker)
	if err != nil {
		return encLaunch{}, err
	}
	if !hasN && !hasA && !hasT {
		if len(staged) > 0 {
			return encLaunch{}, errors.New("staged encrypted volumes without the front's plane")
		}
		return encLaunch{}, nil
	}
	if !hasN || !hasA || !hasT || !encAPIRE.MatchString(api) || !encTokenRE.MatchString(token) {
		return encLaunch{}, errors.New("malformed encrypted-volume launch")
	}
	l := encLaunch{names: strings.Split(names, ","), api: api, token: token}
	if strings.Join(l.names, "\n")+"\n" != strings.Join(staged, "\n")+"\n" || len(staged) == 0 || len(staged) > 8 {
		return encLaunch{}, errors.New("the encrypted volumes are not the staged ones")
	}
	for _, n := range l.names {
		var st syscall.Stat_t
		if !encNameRE.MatchString(n) || syscall.Lstat(root+"/"+n, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
			return encLaunch{}, errors.New("an encrypted volume is not staged")
		}
	}
	return l, nil
}

// readStaged: the monitor's marker, root-owned and read-only, or no staging at all.
func readStaged(marker string) ([]string, error) {
	fi, err := os.Lstat(marker)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0o222 != 0 || !ok || st.Uid != markerOwner || fi.Size() > 1024 {
		return nil, errors.New("the encrypted-volume staging marker is not the monitor's")
	}
	b, err := os.ReadFile(marker)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 || b[len(b)-1] != '\n' {
		return nil, errors.New("malformed encrypted-volume staging marker")
	}
	return strings.Split(strings.TrimSuffix(string(b), "\n"), "\n"), nil
}
