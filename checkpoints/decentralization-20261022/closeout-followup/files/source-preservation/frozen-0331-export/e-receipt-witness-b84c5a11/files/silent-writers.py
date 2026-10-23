"""Heuristic first pass (then read by hand): per external/public function, does its body (and private helpers it
calls, one level) assign storage and emit nothing? Output feeds the manual audit; it is not the audit."""
import re, sys
src = open(sys.argv[1]).read()
src = re.sub(r'//[^\n]*', '', src); src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
funcs = {}
for m in re.finditer(r'\bfunction\s+(\w+)\s*\(([^)]*)\)([^{;]*)\{', src):
    i, depth = m.end(), 1
    while depth and i < len(src):
        depth += {'{': 1, '}': -1}.get(src[i], 0); i += 1
    funcs.setdefault(m.group(1), []).append((m.group(3), src[m.end():i - 1]))
state = set(re.findall(r'^\s*(?:mapping\s*\(.*?\)|[\w\[\]\.]+)\s+(?:public\s+|private\s+|internal\s+)?(\w+)\s*(?:=[^;]*)?;', src, re.M))
def writes(body):
    return sorted({w for w in re.findall(r'\b(_?\w+)\s*(?:\[[^\]]*\])*(?:\.\w+)*\s*(?:=(?!=)|\+=|-=|\+\+|--)', body) if w in state} |
                  {w for w in re.findall(r'\bdelete\s+(_?\w+)', body) if w in state} | {w for w in re.findall(r'\b(\w+)\.push\(', body) if w in state})
for name, defs in funcs.items():
    for mods, body in defs:
        if re.search(r'\b(view|pure)\b', mods): continue
        ext = re.search(r'\b(external|public)\b', mods) or name == 'constructor'
        w = writes(body); emits = re.findall(r'emit\s+(\w+)', body)
        calls = [c for c in re.findall(r'\b(_\w+)\s*\(', body) if c in funcs]
        for c in calls:
            for cm, cb in funcs[c]: w = sorted(set(w) | set(writes(cb))); emits += re.findall(r'emit\s+(\w+)', cb)
        if ext and w and not emits: print(f'SILENT  {name}: writes {w}')
        elif ext and w: print(f'emits   {name}: writes {w} emits {sorted(set(emits))}')
