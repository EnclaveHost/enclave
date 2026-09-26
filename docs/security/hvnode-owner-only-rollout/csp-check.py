# The live site's CSP must carry the hash of every EXECUTABLE inline script on the page (site deploy syncs them; a stale hash
# silently breaks the page). argv[1] = the CSP header; stdin = the page. Prints the missing hashes (12 chars), empty if none.
# Executable = no type, or a JS type, module or importmap; a data block (JSON-LD) is not governed by CSP.
import sys, re, hashlib, base64
csp, html = sys.argv[1], sys.stdin.read()
JS = {"", "text/javascript", "application/javascript", "module", "importmap"}
def typ(attrs):
    m = re.search(r"""\btype=["']?([^"'\s>]+)""", attrs)
    return m.group(1).lower() if m else ""
hs = [base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
      for attrs, body in re.findall(r"<script(?![^>]*\bsrc=)([^>]*)>(.*?)</script>", html, re.S) if body.strip() and typ(attrs) in JS]
if not hs: print("NO-INLINE-SCRIPTS-FOUND", end="")
else: print(" ".join(h[:12] for h in hs if f"'sha256-{h}'" not in csp), end="")
