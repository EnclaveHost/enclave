package bootstrap

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"

	"enclave.host/isolation/contract"
)

// RPCBootstrapOffer is only permission to authenticate this endpoint for one
// exact startup request. It is NOT writer consent, an export, or a root grant.
// Fields are ordered lexically to match the owner's canonical wire encoding.
type RPCBootstrapOffer struct {
	Attempt                 string `json:"attempt"`
	Challenge               string `json:"challenge"`
	ClientCertificateSHA256 string `json:"clientCertificateSha256"`
	CredentialBlob          string `json:"credentialBlob"`
	Host                    string `json:"host"`
	HostNonce               string `json:"hostNonce"`
	ManifestSHA256          string `json:"manifestSha256"`
	Port                    uint16 `json:"port"`
	RequestSHA256           string `json:"requestSha256"`
	Runtime                 string `json:"runtime"`
	Schema                  string `json:"schema"`
	Secret                  string `json:"secret"`
	ServerCertificateSHA256 string `json:"serverCertificateSha256"`
	ServerName              string `json:"serverName"`
}
type RPCBootstrapOfferProof struct {
	Base  string            `json:"base"`
	L1    string            `json:"l1"`
	Offer RPCBootstrapOffer `json:"offer"`
}

func (o RPCBootstrapOffer) Bytes() ([]byte, error) {
	if o.Schema != "enclave-rpc-owner-offer/1" || !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(o.Attempt) {
		return nil, errors.New("exact owner offer required")
	}
	b := RPCExportBinding{Host: o.Host, Port: o.Port, ServerName: o.ServerName, ServerCertificateSHA256: o.ServerCertificateSHA256, ClientCertificateSHA256: o.ClientCertificateSHA256, ContractSHA256: o.RequestSHA256}
	if err := b.Validate(); err != nil {
		return nil, err
	}
	for _, v := range []string{o.Challenge, o.ManifestSHA256, o.Runtime} {
		if !contract.NonzeroHash(v) {
			return nil, errors.New("nonzero offer bindings required")
		}
	}
	for k, v := range map[string]string{"hostNonce": o.HostNonce, "credentialBlob": o.CredentialBlob, "secret": o.Secret} {
		raw, e := base64.StdEncoding.Strict().DecodeString(v)
		if e != nil || len(raw) == 0 || len(raw) > 4096 || base64.StdEncoding.EncodeToString(raw) != v || k == "hostNonce" && len(raw) != 32 {
			return nil, errors.New("bounded canonical TPM offer required")
		}
	}
	return json.Marshal(o)
}
func RPCBootstrapOfferPayload(o RPCBootstrapOffer, role byte) ([]byte, error) {
	raw, e := o.Bytes()
	if e != nil {
		return nil, e
	}
	if role > 1 {
		return nil, errors.New("exact storage role required")
	}
	sum := sha256.Sum256(raw)
	payload := append([]byte("ENCLAVE-RPC-OWNER-ENDPOINT/1\x00"), role)
	return append(payload, sum[:]...), nil
}

// VerifyRPCBootstrapOffer uses CURRENT on-chain-selected keys and package hash;
// no caller-provided public key, registry, CA service or fallback is admitted.
func (a *Authorization) VerifyRPCBootstrapOffer(bundle []byte, r contract.RPCStorageRequest, raw []byte) (RPCBootstrapOffer, error) {
	var proof RPCBootstrapOfferProof
	no := func(e error) (RPCBootstrapOffer, error) { return RPCBootstrapOffer{}, e }
	authorities, e := a.RPCStorageAuthorities(bundle, r)
	if e != nil {
		return no(e)
	}
	if len(raw) == 0 || len(raw) > 16384 {
		return no(errors.New("bounded owner offer required"))
	}
	if e = strictJSON(raw, &proof); e != nil {
		return no(e)
	}
	canonical, e := json.Marshal(proof)
	if e != nil || !bytes.Equal(canonical, raw) {
		return no(errors.New("canonical complete owner offer required"))
	}
	o := proof.Offer
	request, _ := json.Marshal(r)
	sum := sha256.Sum256(request)
	var envelope map[string]json.RawMessage
	var pin commitment
	if json.Unmarshal([]byte(a.snapshot.row.envelope), &envelope) != nil || strictJSON(envelope["guestBootstrap"], &pin) != nil || pin.Version != 1 {
		return no(errors.New("owner package commitment unavailable"))
	}
	if o.RequestSHA256 != hex.EncodeToString(sum[:]) || o.Runtime != a.manifest.RuntimeID || o.ManifestSHA256 != pin.SHA256 {
		return no(errors.New("offer differs from authorized original deployment"))
	}
	for role, signature := range []string{proof.L1, proof.Base} {
		key, _ := hex.DecodeString(authorities[role].PublicKey)
		sig, e := hex.DecodeString(signature)
		if e != nil || len(sig) != 64 || hex.EncodeToString(sig) != signature {
			return no(errors.New("exact owner endpoint signature required"))
		}
		payload, e := RPCBootstrapOfferPayload(o, byte(role))
		if e != nil {
			return no(e)
		}
		if !ed25519.Verify(ed25519.PublicKey(key), payload, sig) {
			return no(errors.New("owner endpoint signature refused"))
		}
	}
	return o, nil
}
