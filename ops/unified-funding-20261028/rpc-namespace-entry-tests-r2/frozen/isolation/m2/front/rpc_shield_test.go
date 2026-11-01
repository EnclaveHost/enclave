//go:build shielddirect && bootstrapdirect && !releaselab

package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestRPCOwnerUsesFullDeploymentWithoutLauncherName(t *testing.T) {
	id := shieldID(0x11)
	auth := &shieldFake{fakeAuthority: fakeAuthority{grant: grantFor("0x"+strings.Repeat("33", 20), nil, "shop.example.com")}, require: shieldBackend, mode: "public"}
	f := shieldFront(t, "")
	f.rpcDeployment = id
	err, got, loaded := shieldRun(t, f, framed(t, id, []byte(`{"version":1}`), nil), auth, nil)
	if err != nil || got != id || !bytes.Equal(loaded.AppID[:], f.appSha) || loaded.RuntimeID != f.rt.RID {
		t.Fatal(err, got, loaded)
	}
	if f.names == nil || !f.names.authorizes("shop.example.com") || f.appZone != nil {
		t.Fatal("owner names or absent app-zone binding incorrect")
	}
}

func TestRPCOwnerRefusesFullIDCollisionAndAuthorityFailures(t *testing.T) {
	id := shieldID(0x11)
	for _, mode := range []string{"same-prefix", "wrong-tier", "custody", "owner-refusal", "expired"} {
		t.Run(mode, func(t *testing.T) {
			f := shieldFront(t, "")
			f.rpcDeployment = id
			frameID := id
			auth := &shieldFake{fakeAuthority: fakeAuthority{grant: grantFor("0x"+strings.Repeat("33", 20), nil, "shop.example.com")}, require: shieldBackend, mode: "public"}
			var refusal error
			switch mode {
			case "same-prefix":
				frameID[31] ^= 1
			case "wrong-tier":
				auth.require = "snp-guest-per-app"
			case "custody":
				auth.mode = "custody-v2"
			case "owner-refusal":
				refusal = errors.New("owner refused loaded identity")
			case "expired":
				auth.reqErr = errors.New("authorization expired")
			}
			err, got, _ := shieldRun(t, f, framed(t, frameID, []byte(`{"version":1}`), nil), auth, refusal)
			if err == nil || f.names != nil {
				t.Fatal("unauthorized owner startup", err)
			}
			if mode == "same-prefix" && got != [32]byte{} {
				t.Fatal("wrong full ID reached authorization")
			}
		})
	}
}
