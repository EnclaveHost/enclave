package main

import "strings"

// staleLoopbackSIDs reads `CheckNetIsolation.exe LoopbackExempt -s` and returns the SIDs of exemptions whose
// AppContainer no longer exists ("AppContainer NOT FOUND"). A circuit killed without its removal (an update stopping
// every process, a host restart) left its exemption behind; 675 of them piled up on nucbox-k11-4 by 2026-10-14 08:04Z and
// `LoopbackExempt -a` then failed with exit status 87 for every new circuit, so no app had a route. Only exemptions whose
// AppContainer is gone are returned: a live one (this host's other circuits, anything else installed) is never touched.
func staleLoopbackSIDs(listing string) []string {
	var out []string
	name := ""
	for _, raw := range strings.Split(strings.ReplaceAll(listing, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "Name:"):
			name = strings.TrimSpace(strings.TrimPrefix(line, "Name:"))
		case strings.HasPrefix(line, "SID:"):
			sid := strings.TrimSpace(strings.TrimPrefix(line, "SID:"))
			if strings.EqualFold(name, "AppContainer NOT FOUND") && strings.HasPrefix(sid, "S-1-15-2-") && !strings.ContainsAny(sid, " \t\"") {
				out = append(out, sid)
			}
			name = ""
		case strings.HasPrefix(line, "[") || line == "":
			name = ""
		}
	}
	return out
}
