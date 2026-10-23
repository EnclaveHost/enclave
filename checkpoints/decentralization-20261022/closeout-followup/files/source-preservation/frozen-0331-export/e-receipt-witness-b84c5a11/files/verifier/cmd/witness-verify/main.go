// witness-verify FIXTURE.json[.gz] ANCHOR_BLOCK_HASH: offline; prints the verified lease view or exits 1 with the
// refusal. The fixture (and its decompressed form) may be at most WITNESS_MAX_FIXTURE_BYTES (default 600 MiB, above
// DefaultLimits.MaxTotalBytes); every part is bounded again by DefaultLimits before it is parsed.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/ethereum/go-ethereum/common"

	"enclave.host/receiptwitness"
)

const defaultMaxFixtureBytes = 600 << 20

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: witness-verify FIXTURE.json[.gz] ANCHOR_BLOCK_HASH")
		os.Exit(2)
	}
	max := int64(defaultMaxFixtureBytes)
	if v := os.Getenv("WITNESS_MAX_FIXTURE_BYTES"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 || n > defaultMaxFixtureBytes {
			fmt.Fprintln(os.Stderr, "WITNESS_MAX_FIXTURE_BYTES must be 1..", defaultMaxFixtureBytes)
			os.Exit(2)
		}
		max = n
	}
	raw, err := receiptwitness.ReadFixtureFile(os.Args[1], max)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var fx receiptwitness.Fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	v, err := receiptwitness.Verify(fx, common.HexToHash(os.Args[2]))
	if err != nil {
		fmt.Println(`{"refused":` + fmt.Sprintf("%q", err.Error()) + `}`)
		os.Exit(1)
	}
	out, _ := json.MarshalIndent(v, "", " ")
	fmt.Println(string(out))
}
