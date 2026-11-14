package main

import (
	"regexp"
	"strings"
)

var circuitProfile = regexp.MustCompile(`(?i)^enclave\.circuit\.([a-f0-9]{32})$`)

// staleLoopbackSIDs reads `CheckNetIsolation.exe LoopbackExempt -s` and returns the SIDs of exemptions to remove. A
// circuit killed without its removal (an update stopping every process, a host restart) left its exemption behind; 675
// of them piled up on nucbox-k11-4 by 2026-10-14 08:04Z and `LoopbackExempt -a` then failed with exit status 87 for every
// new circuit, so no app had a route. Two kinds are candidates, and dead decides each:
//   - "AppContainer NOT FOUND", asked as dead("", sid): this account knows no such AppContainer. Another account's
//     running circuits are listed like this too.
//   - "enclave.circuit.<id>", asked as dead(id, sid): one of this host's own circuits. A killed circuit keeps its
//     AppContainer profile, so the account that created it (the agent runs as SYSTEM) reads its name here, not NOT FOUND.
//     With the first kind alone nothing was ever pruned on the host and the list was full again on 2026-11-14 (682
//     entries, about 20 failed circuits in five minutes).
//
// Any other exemption (anything else installed) is never touched.
func staleLoopbackSIDs(listing string, dead func(circuit, sid string) bool) []string {
	var out []string
	name := ""
	for _, raw := range strings.Split(strings.ReplaceAll(listing, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "Name:"):
			name = strings.TrimSpace(strings.TrimPrefix(line, "Name:"))
		case strings.HasPrefix(line, "SID:"):
			sid := strings.TrimSpace(strings.TrimPrefix(line, "SID:"))
			own := circuitProfile.FindStringSubmatch(name)
			if strings.HasPrefix(sid, "S-1-15-2-") && !strings.ContainsAny(sid, " \t\"") &&
				(strings.EqualFold(name, "AppContainer NOT FOUND") && dead("", sid) || own != nil && dead(strings.ToLower(own[1]), sid)) {
				out = append(out, sid)
			}
			name = ""
		case strings.HasPrefix(line, "[") || line == "":
			name = ""
		}
	}
	return out
}
