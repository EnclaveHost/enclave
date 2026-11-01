package main

// encvol in the front: a deployment's encrypted volumes (isolation/m2/encvol), started between the release and the
// app's start, in the same step as the egress forwarders (provision.go startForwarders):
//
//  1. the owner's config (sealed to this guest, resolved here) names the volumes; their S3 endpoints join the egress
//     allowlist BEFORE the forwarders start, so each gets a forwarder and an /etc/hosts entry like any allowed origin;
//  2. each volume is staged as its own sized tmpfs at /enc/<name>, owned by the app's uid, EMPTY;
//  3. the tenant plane listens on this guest's loopback only and joins the listener audit's expected set;
//  4. init receives, after the config, the plane's URL, the deployment's token and the volume names, and gives the
//     app the /enc/<name> live preopens and ENCLAVE_ENC / ENCLAVE_ENC_API / ENCLAVE_ENC_TOKEN (dominit.c).
//
// The key and the plaintext never leave this guest: the app sends the password to the plane over loopback, the
// plane keys rclone's crypt cipher in this process (encvol/rclonecrypt), the ciphertext travels TLS end to end to the
// owner's S3 endpoint through the egress forwarder, and the plaintext lands in guest-memory tmpfs. Nothing of it is
// printed (console lines name a volume and an outcome), written outside the volumes, or sent to the host.

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"enclave.host/isolation/m2/appconfig"
	"enclave.host/isolation/m2/egress"
	"enclave.host/isolation/m2/encvol"
)

const (
	encListenAddr = "127.0.0.1:50080" // above the 1-49999 an app may bind (/app.run, /app.ports): never the app's
	encAppUID     = 1000              // dominit.c APP_UID / APP_GID
	encAppGID     = 1000
	encMarker     = "/rt/encvol.enabled" // the image states the capability (guestd reports it; the supervisor gates on it)
	encAuditEvery = 10 * time.Second     // the manager's AUDIT_SECS
)

// encvolHost is what a guest supplies to run volumes; nil = this image has no encrypted-volume engine.
type encvolHost struct {
	root   string
	uid    int
	gid    int
	listen string
	mount  func(dir string, maxMB int) error
	kill   func(reason string)
	parse  encvol.ParseOptions                                               // zero in a guest
	dial   func(ctx context.Context, network, addr string) (net.Conn, error) // tests only
	memMiB func() (int, error)                                               // the guest's memory; nil = unchecked (tests)
	roots  *x509.CertPool                                                    // tests only; nil = the embedded public roots
	shared bool                                                              // a Hyper-V partition domain (encvol.Options.Shared)
}

// encStarted is a running plane: its listener address (for the audit) and init's trailer.
type encStarted struct {
	svc   *encvol.Service
	addr  netip.AddrPort
	block []byte // init's trailer (an SNP guest)
	api   string // the same three facts, for secretrun's pipe (a Hyper-V partition domain)
	token string
	names []string
}

// guestEncvol is the guest's engine (compiled into this front), or nil when the image does not state the capability:
// an image whose init predates the trailer must not be handed volumes it could not give the app.
func guestEncvol() *encvolHost {
	if b, err := os.ReadFile(encMarker); err != nil || string(b) != "1\n" {
		return nil
	}
	return &encvolHost{root: encvol.GuestRoot, uid: encAppUID, gid: encAppGID, listen: encListenAddr,
		mount: tmpfsMount, kill: killApp, memMiB: guestMemMiB}
}

// tmpfsMount: a volume's own tmpfs (encvol.TmpfsMiB), owned by the app, never executable.
func tmpfsMount(dir string, maxMB int) error {
	opts := fmt.Sprintf("size=%dm,mode=0700,uid=%d,gid=%d", encvol.TmpfsMiB(maxMB), encAppUID, encAppGID)
	return syscall.Mount("tmpfs", dir, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, opts)
}

// guestMemMiB is this guest's MemTotal.
func guestMemMiB() (int, error) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if f := strings.Fields(line); len(f) >= 2 && f[0] == "MemTotal:" {
			kb, err := strconv.Atoi(f[1])
			return kb / 1024, err
		}
	}
	return 0, errors.New("no MemTotal")
}

// killApp ends every process running as the app's uid (the runtime); init sees the app exit and
// powers the domain off, as for any app that ends.
func killApp(reason string) {
	fmt.Printf("DOM encvol cap exceeded: ending the app\n") // the reason names a volume and sizes only; the console gets neither
	_ = reason
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "status"))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			if f := strings.Fields(line); len(f) >= 2 && f[0] == "Uid:" && f[1] == strconv.Itoa(encAppUID) {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	}
}

// encPrepare reads encVolumes from the resolved config and adds each endpoint's origin to the policy, before the
// forwarders start. A bad entry is a failed launch, as on the standard tier.
func encPrepare(config string, pol *egress.Policy, host *encvolHost) ([]encvol.Spec, error) {
	var po encvol.ParseOptions
	if host != nil {
		po = host.parse
	}
	specs, err := encvol.Parse(config, po)
	if err != nil || len(specs) == 0 {
		return nil, err
	}
	if host == nil {
		return nil, errors.New("the config names encVolumes, and this image carries no encrypted-volume engine: the app is not started without its mounts")
	}
	// every volume is guest RAM: refuse a launch whose volumes at their caps would not leave the runtime and app room
	// (the supervisor refuses the same claim against the version's memMb; this is the guest's own check)
	if host.memMiB != nil {
		mem, err := host.memMiB()
		if err != nil {
			return nil, fmt.Errorf("encVolumes: the guest's memory could not be read: %v", err)
		}
		need := 0
		for _, s := range specs {
			need += encvol.TmpfsMiB(s.MaxMB)
		}
		if need+encvol.GuestReserveMiB > mem {
			return nil, fmt.Errorf("encVolumes need %d MiB of this guest's %d MiB (a per-app guest holds each volume in RAM; %d MiB stays for the runtime and app): the app is not started without its mounts",
				need, mem, encvol.GuestReserveMiB)
		}
	}
	have := map[string]bool{}
	for _, o := range pol.Origins {
		have[o.Host] = true
	}
	for _, s := range specs {
		if s.Origin() == "" {
			continue // a test hook endpoint (local:, loopback http)
		}
		o, err := egress.ParseOrigin(s.Origin())
		if err != nil {
			return nil, fmt.Errorf("encVolumes '%s': %v", s.Name, err)
		}
		if !have[o.Host] {
			pol.Origins = append(pol.Origins, o)
			have[o.Host] = true
		}
	}
	sort.Slice(pol.Origins, func(i, j int) bool { return pol.Origins[i].Host < pol.Origins[j].Host })
	return specs, nil
}

// encStart stages the volumes and starts the plane for deployment id.
func encStart(ctx context.Context, id [32]byte, specs []encvol.Spec, host *encvolHost, logf func(string, ...any)) (*encStarted, error) {
	vid := fmt.Sprintf("0x%x", id[:])
	svc, err := encvol.New(vid, specs, encvol.Options{Root: host.root, UID: host.uid, GID: host.gid,
		Mount: host.mount, Kill: host.kill, Logf: logf, Parse: host.parse, Dial: host.dial, Roots: host.roots, Shared: host.shared})
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", host.listen)
	if err != nil {
		return nil, fmt.Errorf("the encrypted-volume plane: %v", err)
	}
	addr, err := netip.ParseAddrPort(ln.Addr().String())
	if err != nil {
		ln.Close()
		return nil, err
	}
	srv := &http.Server{Handler: svc, ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	go svc.RunAudit(ctx, encAuditEvery)
	out := &encStarted{svc: svc, addr: addr, api: fmt.Sprintf("http://%s/encvol/%s", addr, vid), token: svc.Token()}
	var b bytes.Buffer
	b.WriteString("E1\n")
	fmt.Fprintf(&b, "api=%s\n", out.api)
	fmt.Fprintf(&b, "token=%s\n", out.token)
	for _, m := range svc.Mounts() {
		fmt.Fprintf(&b, "vol=%s\n", m[0])
		out.names = append(out.names, m[0])
	}
	out.block = b.Bytes()
	logf("DOM encvol: %d volume(s) staged locked at %s/<name>; plane on loopback", len(specs), host.root)
	return out, nil
}

// handToInitEnc is handToInitMode plus init's encrypted-volume trailer: the config, a NUL (a config never holds one),
// then the block encStart wrote. No trailer without a config.
func handToInitEnc(w *os.File, config string, publicHTTPS bool, enc []byte) error {
	if len(enc) == 0 {
		return handToInitMode(w, config, publicHTTPS)
	}
	defer w.Close()
	if config == "" {
		return errors.New("an encrypted-volume trailer without a config")
	}
	tag := byte('C')
	if publicHTTPS {
		tag = 'P'
	}
	msg := make([]byte, 0, 2+len(config)+len(enc))
	msg = append(msg, tag)
	msg = append(msg, config...)
	msg = append(msg, 0)
	msg = append(msg, enc...)
	_, err := w.Write(msg)
	for i := range msg {
		msg[i] = 0
	}
	return err
}

// ---- a Hyper-V partition domain (isolation/m3: the monitor stages, secretrun preopens) ----------------------------

// encShieldMarker is the monitor's statement that it staged this domain's volumes (monitor stageEncVolumes): root-owned,
// read-only, one name per line. Without it a domain has no volumes, and a config naming some is refused.
const encShieldMarker = "/enc.volumes"

// shieldEncvol is a partition domain's engine: this front is not root, so the monitor mounted each volume (a tmpfs,
// group-shared with the app, sized from the measured config) and domexec put this front in the app's group.
func shieldEncvol() *encvolHost {
	fi, err := os.Lstat(encShieldMarker)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0o222 != 0 {
		return nil
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); !ok || st.Uid != 0 {
		return nil
	}
	return &encvolHost{root: encvol.GuestRoot, uid: -1, gid: -1, listen: encListenAddr, shared: true, kill: endDomain}
}

// endDomain is the audit's sanction where this front cannot signal the app's uid: it ends itself, and domexec ends the
// domain when either workload exits.
func endDomain(reason string) {
	fmt.Printf("DOM encvol cap exceeded: ending the domain\n") // the reason names a volume and sizes only; the console gets neither
	_ = reason
	os.Exit(3)
}

// encSpecs: the volumes of a partition domain's MEASURED config, resolved with the domain's secrets (endpoint, bucket
// and path may be "$SECRET" references, as on the standard runtime), their origins added to the policy; the resolved
// volumes must be exactly the ones the monitor staged from the measured bytes.
func (e *shieldEgress) encSpecs(measured string, secrets map[string]string, pol *egress.Policy) ([]encvol.Spec, error) {
	layout, err := encvol.ParseLayout(measured)
	if err != nil {
		return nil, egressStepError{"encrypted volumes"}
	}
	if len(layout) == 0 {
		return nil, nil
	}
	resolved, err := appconfig.Resolve(measured, secrets)
	if err != nil {
		return nil, egressStepError{"encrypted volumes"}
	}
	specs, err := encPrepare(resolved, pol, e.enc)
	if err != nil || !encvol.SameLayout(layout, specs) || !e.encStaged(specs) {
		return nil, egressStepError{"encrypted volumes"}
	}
	return specs, nil
}

// encStaged: the monitor's marker names exactly these volumes.
func (e *shieldEgress) encStaged(specs []encvol.Spec) bool {
	marker := e.encMarker
	if marker == "" {
		marker = encShieldMarker
	}
	b, err := os.ReadFile(marker)
	if err != nil {
		return false
	}
	var want strings.Builder
	for _, s := range specs {
		want.WriteString(s.Name + "\n")
	}
	return string(b) == want.String()
}

// addEnc puts the plane's URL, the token and the names on secretrun's pipe (reserved ENCLAVE_ENC* keys, which no owner
// secret may use: shieldconfig.Validate refuses the ENCLAVE_ prefix).
func (e *shieldEgress) addEnc(m map[string]string) {
	if e == nil || e.encOut == nil {
		return
	}
	m["ENCLAVE_ENC"] = strings.Join(e.encOut.names, ",")
	m["ENCLAVE_ENC_API"] = e.encOut.api
	m["ENCLAVE_ENC_TOKEN"] = e.encOut.token
}
