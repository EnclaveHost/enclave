// enclave-63's one-off: catalog.DeriveBundle(record, component) -> the bundle guestd would stage; prints its sha256.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"enclave.host/isolation/contract/catalog"
)

func main() {
	var d catalog.Derivation
	rb, err := os.ReadFile(os.Args[1])
	if err != nil { panic(err) }
	if err := json.Unmarshal(rb, &d); err != nil { panic(err) }
	comp, err := os.ReadFile(os.Args[2])
	if err != nil { panic(err) }
	b, err := catalog.DeriveBundle(d, comp)
	if err != nil { fmt.Fprintln(os.Stderr, "derive:", err); os.Exit(1) }
	if err := os.WriteFile(os.Args[3], b, 0o600); err != nil { panic(err) }
	s := sha256.Sum256(b); dg, _ := d.Digest()
	fmt.Printf("bundle %d bytes app_id %s record %s\n", len(b), hex.EncodeToString(s[:]), hex.EncodeToString(dg[:]))
}
