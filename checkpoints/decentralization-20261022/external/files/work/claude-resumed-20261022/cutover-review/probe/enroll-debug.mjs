import fs from "node:fs";
const t = fs.readFileSync(process.argv[2], "utf8"); const i = t.indexOf('$js = "'); const lines = [];
for (const l of t.slice(i).split("\n")) { lines.push(l); if (!l.trimEnd().endsWith("+")) break; }
console.log([...lines.join("\n").matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("").slice(0, 400));
