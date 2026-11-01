//go:build shielddirect && bootstrapdirect && !releaselab

package main

// The Shield-direct front starts app-zone issuance (appzone.go) for exactly its own name when its owner-committed package
// selects it, through the same authorization the owner names use; a package without the member keeps every existing path.
// The replica's Shield verification is network/app-zone-shield.mjs (test/app-zone-shield*.test.mjs); the issuer against
// separate Shield replica processes is appzone_shield_process_test.go.
// run: go test -tags 'bootstrapdirect shielddirect' -run ShieldDirectAppZone ./front/
import (
	"strings"
	"testing"

	"enclave.host/isolation/m2/bootstrap"
)

func shieldAppGrant(dep [32]byte, eab bool) bootstrap.NameGrant {
	g := appGrant("0x"+strings.Repeat("33", 20), repA, repB)
	g.Deployment = dep
	if eab {
		g.AppZone.EAB = &bootstrap.NameEAB{}
	}
	return g
}

func TestShieldDirectAppZoneStartsForItsOwnAuthorizedName(t *testing.T) {
	id := shieldID(0x11)
	f := shieldFront(t, "11111111.app.enclave.host")
	auth := &shieldFake{fakeAuthority: fakeAuthority{grant: shieldAppGrant(id, false)}, require: shieldBackend, mode: "public"}
	if err, _, _ := shieldRun(t, f, framed(t, id, []byte(`{"version":1}`), nil), auth, nil); err != nil {
		t.Fatal(err)
	}
	if f.appZone == nil || f.appZone.name != "11111111.app.enclave.host" || len(f.appZone.cfg.Challenges) != 2 {
		t.Fatalf("app-zone issuance not started for this domain's own name: %+v", f.appZone)
	}
	if f.appZone.signer != f.certs.key || string(f.appZone.spki) != string(f.spki) {
		t.Fatal("the issuer does not use this domain's own TLS key")
	}
	if f.appZone.attest == nil {
		t.Fatal("pushes carry no attestation")
	}
}

func TestShieldDirectAppZoneKeepsEveryOtherPathWithoutTheMember(t *testing.T) {
	id := shieldID(0x11)
	f := shieldFront(t, "11111111.app.enclave.host")
	auth := &shieldFake{fakeAuthority: fakeAuthority{grant: grantFor("0x"+strings.Repeat("33", 20), nil, "shop.example.com")}, require: shieldBackend, mode: "public"}
	if err, _, _ := shieldRun(t, f, framed(t, id, []byte(`{"version":1}`), nil), auth, nil); err != nil {
		t.Fatal(err)
	}
	if f.appZone != nil {
		t.Fatal("app-zone issuance started without the package selecting it")
	}
	if f.names == nil || !f.names.authorizes("shop.example.com") {
		t.Fatal("owner names no longer start")
	}
}

func TestShieldDirectAppZoneNeverCertifiesAnotherDeploymentsName(t *testing.T) {
	// the launcher's name and the framed package say 0x11..., but the chain-verified authorization is another deployment's:
	// no issuer (the app still starts; nothing is certified)
	id := shieldID(0x11)
	f := shieldFront(t, "11111111.app.enclave.host")
	auth := &shieldFake{fakeAuthority: fakeAuthority{grant: shieldAppGrant(shieldID(0x22), false)}, require: shieldBackend, mode: "public"}
	if err, _, _ := shieldRun(t, f, framed(t, id, []byte(`{"version":1}`), nil), auth, nil); err != nil {
		t.Fatal(err)
	}
	if f.appZone != nil {
		t.Fatalf("an issuer started for %s under another deployment's authorization", f.appZone.name)
	}
	// a CA needing an EAB this public-mode guest could not resolve: stated, not started
	f = shieldFront(t, "11111111.app.enclave.host")
	auth = &shieldFake{fakeAuthority: fakeAuthority{grant: shieldAppGrant(id, true)}, require: shieldBackend, mode: "public"}
	if err, _, _ := shieldRun(t, f, framed(t, id, []byte(`{"version":1}`), nil), auth, nil); err != nil {
		t.Fatal(err)
	}
	if f.appZone != nil {
		t.Fatal("started without the EAB the selected CA needs")
	}
}
