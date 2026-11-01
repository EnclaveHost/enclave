package appconfig

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Cases the standard runtime's rule must give the same answer for. `want` was produced by the REAL
// wasm/wasm_manager.py _subst_secrets (TestParityWithStandardRuntime re-derives every one of them from that source,
// so a drift on either side fails there).
var cases = []struct {
	name, config string
	secrets      map[string]string
	want         string
}{
	{"no secrets: raw bytes", `{ "a" : "$X" }`, nil, `{ "a" : "$X" }`},
	{"no dollar: raw bytes", `{ "a" : 1 ,"b":[ 2 ] }`, map[string]string{"X": "v"}, `{ "a" : 1 ,"b":[ 2 ] }`},
	{"$NAME and ${NAME}", `{"a":"$X","b":"pre-${X}-post"}`, map[string]string{"X": "v"}, `{"a":"v","b":"pre-v-post"}`},
	{"$$ escapes", `{"a":"$$X costs $$5"}`, map[string]string{"X": "v"}, `{"a":"$X costs $5"}`},
	{"unknown name kept", `{"a":"$NOPE and $X"}`, map[string]string{"X": "v"}, `{"a":"$NOPE and v"}`},
	{"keys never substituted", `{"$X":"$X"}`, map[string]string{"X": "v"}, `{"$X":"v"}`},
	{"nested + arrays, order kept", `{"z":1,"a":{"k":["$X",{"q":"${X}"}]},"m":true,"n":null}`, map[string]string{"X": "v"},
		`{"z":1,"a":{"k":["v",{"q":"v"}]},"m":true,"n":null}`},
	{"quotes and backslashes in a secret", `{"a":"$X"}`, map[string]string{"X": `q"b\s`}, `{"a":"q\"b\\s"}`},
	{"non-ascii escaped like ensure_ascii", `{"a":"é $X 😀"}`, map[string]string{"X": "ü"}, `{"a":"\u00e9 \u00fc \ud83d\ude00"}`},
	{"control chars", "{\"a\":\"$X\\u0001\\t\"}", map[string]string{"X": "v"}, `{"a":"v\u0001\t"}`},
	{"duplicate key: last value, first place", `{"a":"1","b":"$X","a":"2"}`, map[string]string{"X": "v"}, `{"a":"2","b":"v"}`},
	{"a name glued to text", `{"a":"$X_Y $X-Y ${X}_Y"}`, map[string]string{"X": "v", "X_Y": "w"}, `{"a":"w v-Y v_Y"}`},
	{"a top-level string", `"$X"`, map[string]string{"X": "v"}, `"v"`},
}

func TestResolve(t *testing.T) {
	for _, c := range cases {
		got, err := Resolve(c.config, c.secrets)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Fatalf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

func TestSecretsAreValidatedLikeTheStandardRuntime(t *testing.T) {
	long := strings.Repeat("x", MaxSecretValue+1)
	many := map[string]string{}
	for i := 0; i <= MaxSecrets; i++ {
		many["K"+strings.Repeat("A", i%60)+string(rune('A'+i%26))+string(rune('A'+i/26))] = "v"
	}
	for name, s := range map[string]map[string]string{
		"bad name":        {"1X": "v"},
		"reserved prefix": {"enclave_x": "v"},
		"newline":         {"X": "a\nb"},
		"NUL":             {"X": "a\x00b"},
		"value too long":  {"X": long},
		"too many":        many,
	} {
		if _, err := Resolve(`{"a":"$X"}`, s); err == nil {
			t.Fatalf("%s: accepted", name)
		} else if strings.Contains(err.Error(), "a\nb") || strings.Contains(err.Error(), long) {
			t.Fatalf("%s: the error carries the secret's value", name)
		}
	}
}

func TestNotJSONIsAnErrorNotAPassThrough(t *testing.T) {
	for _, bad := range []string{`{"a":"$X"`, `{"a":"$X"} trailing`, `$X`} {
		if _, err := Resolve(bad, map[string]string{"X": "v"}); err == nil {
			t.Fatalf("%q resolved without error", bad)
		}
	}
}

func TestEnvValueCeiling(t *testing.T) {
	if v, ok := EnvValue(`{"a":1}`); !ok || v != `{"a":1}` {
		t.Fatal("a small config must ride ENCLAVE_CONFIG")
	}
	if _, ok := EnvValue(strings.Repeat("x", EnvMaxBytes+1)); ok {
		t.Fatal("a config past the ceiling must not ride the environment")
	}
	if _, ok := EnvValue(""); ok {
		t.Fatal("an empty config sets no ENCLAVE_CONFIG")
	}
}

// Parity with the REAL rule: the regex and function are cut out of wasm/wasm_manager.py at test time and run under
// python3 on every case above. Skipped (and said so) only where python3 is absent; the golden `want`s above still run.
func TestParityWithStandardRuntime(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 absent: the golden cases in TestResolve still hold the rule")
	}
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "wasm", "wasm_manager.py"))
	if err != nil {
		t.Fatalf("the standard runtime's source must be readable from this tree: %v", err)
	}
	re := regexp.MustCompile(`(?m)^_SECRET_REF_RE = .*\n`).Find(src)
	fn := regexp.MustCompile(`(?ms)^def _subst_secrets\(.*?\n\n\n`).Find(src)
	if re == nil || fn == nil {
		t.Fatal("could not find _SECRET_REF_RE / _subst_secrets in wasm/wasm_manager.py: update this test with the rule")
	}
	type pcase struct {
		Config  string            `json:"config"`
		Secrets map[string]string `json:"secrets"`
	}
	var in []pcase
	for _, c := range cases {
		in = append(in, pcase{c.config, c.secrets})
	}
	payload, _ := json.Marshal(in)
	script := "import json, re, sys\n" + string(re) + string(fn) +
		"for c in json.loads(sys.stdin.read()):\n    print(json.dumps(_subst_secrets(c['config'], c['secrets'] or {})))\n"
	cmd := exec.Command(py, "-c", script)
	cmd.Stdin = strings.NewReader(string(payload))
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("python: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) != len(cases) {
		t.Fatalf("python answered %d cases, want %d", len(lines), len(cases))
	}
	for i, c := range cases {
		var want string
		if err := json.Unmarshal([]byte(lines[i]), &want); err != nil {
			t.Fatal(err)
		}
		if want != c.want {
			t.Fatalf("%s: the standard runtime gives %s, this test expects %s", c.name, want, c.want)
		}
	}
}
