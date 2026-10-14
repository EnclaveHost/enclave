// Package appconfig assembles a tenant's configuration INSIDE a per-app guest.
//
// The guest receives two things over its attested channel to the relay (isolation/contract/APP-CONFIG.md): the
// deployment's config document (the override the owner set on chain, or the version's) and the deployment's
// secrets. Nothing here fetches either; this package only turns them into what the component sees, and it does so
// with EXACTLY the standard runtime's rule (wasm/wasm_manager.py: _subst_secrets, _validate_secrets), so an app
// cannot tell which tier it runs on:
//
//   - $NAME and ${NAME} inside STRING values of the parsed JSON resolve to the secret of that name;
//   - $$ is a literal $; a name that is not a secret keeps its literal text (configs may contain dollar signs);
//   - substitution walks the parsed document, so a secret holding quotes or backslashes is re-serialized safely,
//     never spliced into raw JSON text;
//   - no secrets, or no '$' in the text, and the config passes through byte for byte.
//
// Why the substitution is here and not on the host: the host would then hold the resolved values. In a per-app
// guest the resolved text exists only in this process and in the component's environment and /config file.
package appconfig

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// The standard runtime's limits (wasm/wasm_manager.py SECRETS_MAX_KEYS, SECRETS_MAX_VALUE, SECRETS_MAX_TOTAL,
// CONFIG_ENV_MAX_BYTES). A secret set the standard tier would refuse is refused here too.
const (
	MaxSecrets      = 64
	MaxSecretValue  = 4096
	MaxSecretsTotal = 16384
	EnvMaxBytes     = 64 * 1024 // ENCLAVE_CONFIG carries the config only up to this; past it, /config alone does
)

var (
	secretNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
	// _SECRET_REF_RE, verbatim: group 1 = the escaped "$", group 2 = ${NAME}, group 3 = $NAME
	secretRefRE = regexp.MustCompile(`\$(\$)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)
)

// ValidateSecrets applies _validate_secrets: env-var names, the ENCLAVE_ prefix reserved, no NUL or newline in a
// value, and the size limits. The error names the offending secret, never its value.
func ValidateSecrets(secrets map[string]string) error {
	if len(secrets) > MaxSecrets {
		return fmt.Errorf("too many secrets (max %d)", MaxSecrets)
	}
	total := 0
	for k, v := range secrets {
		if !secretNameRE.MatchString(k) {
			return fmt.Errorf("secret name %q is not an env-var name", k)
		}
		if strings.HasPrefix(strings.ToUpper(k), "ENCLAVE_") {
			return fmt.Errorf("secret name %q: the ENCLAVE_ prefix is reserved", k)
		}
		if strings.ContainsAny(v, "\x00\n\r") {
			return fmt.Errorf("secret %q contains a NUL or newline", k)
		}
		if len(v) > MaxSecretValue {
			return fmt.Errorf("secret %q is %d bytes (max %d)", k, len(v), MaxSecretValue)
		}
		total += len(k) + len(v)
	}
	if total > MaxSecretsTotal {
		return fmt.Errorf("secrets total %d bytes (max %d)", total, MaxSecretsTotal)
	}
	return nil
}

// Resolve returns the config text the component receives: the placeholders resolved from secrets.
func Resolve(config string, secrets map[string]string) (string, error) {
	if err := ValidateSecrets(secrets); err != nil {
		return "", err
	}
	if len(secrets) == 0 || !strings.Contains(config, "$") {
		return config, nil // byte for byte, as the standard runtime passes it
	}
	doc, err := parse(config)
	if err != nil {
		return "", fmt.Errorf("the config is not a JSON document: %w", err)
	}
	var out bytes.Buffer
	doc.write(&out, func(s string) string { return substitute(s, secrets) })
	return out.String(), nil
}

// EnvValue is what ENCLAVE_CONFIG carries: the resolved config when it fits, otherwise nothing (the component then
// reads /config, which always holds it). The same ceiling as the standard runtime.
func EnvValue(resolved string) (string, bool) {
	if resolved == "" || len(resolved) > EnvMaxBytes {
		return "", false
	}
	return resolved, true
}

func substitute(s string, secrets map[string]string) string {
	idx := secretRefRE.FindAllStringSubmatchIndex(s, -1)
	if idx == nil {
		return s
	}
	var b strings.Builder
	last := 0
	for _, m := range idx {
		b.WriteString(s[last:m[0]])
		switch {
		case m[2] >= 0: // $$
			b.WriteByte('$')
		default:
			name := ""
			if m[4] >= 0 {
				name = s[m[4]:m[5]]
			} else {
				name = s[m[6]:m[7]]
			}
			if v, ok := secrets[name]; ok {
				b.WriteString(v)
			} else {
				b.WriteString(s[m[0]:m[1]]) // unknown name: keep literal
			}
		}
		last = m[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

// ---- an order-preserving JSON document, with Python's json.loads/json.dumps behaviour where it shows ----

type node struct {
	kind byte // 's' string, 'n' number, 'b' bool, 'z' null, 'a' array, 'o' object
	str  string
	num  json.Number
	b    bool
	arr  []*node
	keys []string // first-insertion order, as a Python dict keeps it
	obj  map[string]*node
}

func parse(text string) (*node, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	n, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF { // json.loads refuses trailing data
		return nil, errors.New("trailing data after the document")
	}
	return n, nil
}

func parseValue(dec *json.Decoder) (*node, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			n := &node{kind: 'o', obj: map[string]*node{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, errors.New("object key is not a string")
				}
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				if _, seen := n.obj[k]; !seen {
					n.keys = append(n.keys, k)
				}
				n.obj[k] = v // a duplicate key: the LAST value wins at the FIRST position, as in a Python dict
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return n, nil
		case '[':
			n := &node{kind: 'a'}
			for dec.More() {
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				n.arr = append(n.arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return n, nil
		}
		return nil, fmt.Errorf("unexpected %v", t)
	case string:
		return &node{kind: 's', str: t}, nil
	case json.Number:
		return &node{kind: 'n', num: t}, nil
	case bool:
		return &node{kind: 'b', b: t}, nil
	case nil:
		return &node{kind: 'z'}, nil
	}
	return nil, fmt.Errorf("unexpected token %v", tok)
}

// write serializes compactly (separators "," and ":") and escapes as Python's ensure_ascii does. Number literals are
// kept as written, so the result is value-identical to the standard runtime's (a float such as 1e5 may be spelled
// differently there; no app reads the spelling).
func (n *node) write(w *bytes.Buffer, str func(string) string) {
	switch n.kind {
	case 's':
		writeString(w, str(n.str))
	case 'n':
		w.WriteString(n.num.String())
	case 'b':
		if n.b {
			w.WriteString("true")
		} else {
			w.WriteString("false")
		}
	case 'z':
		w.WriteString("null")
	case 'a':
		w.WriteByte('[')
		for i, v := range n.arr {
			if i > 0 {
				w.WriteByte(',')
			}
			v.write(w, str)
		}
		w.WriteByte(']')
	case 'o':
		w.WriteByte('{')
		for i, k := range n.keys {
			if i > 0 {
				w.WriteByte(',')
			}
			writeString(w, k) // keys are never substituted: only string VALUES are
			w.WriteByte(':')
			n.obj[k].write(w, str)
		}
		w.WriteByte('}')
	}
}

// writeString is json.dumps(ensure_ascii=True) for one string: printable ASCII as is, the short escapes, and every
// other code point as \uXXXX (a surrogate pair beyond the BMP).
func writeString(w *bytes.Buffer, s string) {
	w.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch {
		case r == '"':
			w.WriteString(`\"`)
		case r == '\\':
			w.WriteString(`\\`)
		case r == '\n':
			w.WriteString(`\n`)
		case r == '\r':
			w.WriteString(`\r`)
		case r == '\t':
			w.WriteString(`\t`)
		case r == '\b':
			w.WriteString(`\b`)
		case r == '\f':
			w.WriteString(`\f`)
		case r >= 0x20 && r <= 0x7e:
			w.WriteRune(r)
		case r > 0xffff:
			hi, lo := utf16.EncodeRune(r)
			fmt.Fprintf(w, `\u%04x\u%04x`, hi, lo)
		default:
			fmt.Fprintf(w, `\u%04x`, r)
		}
	}
	w.WriteByte('"')
}
