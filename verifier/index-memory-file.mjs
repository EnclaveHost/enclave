// verifier/index-memory-file.mjs: the index memory's store on a file (Node): read whole, written atomically (tmp + rename).
// An unreadable file is "unreadable" (the memory starts without a record and says so); a directory that cannot be written
// makes save() false, so the memory reports persisted:false and never calls an unsaved record durable.
import fs from "node:fs";
import path from "node:path";
import { createIndexMemory } from "./index-memory.mjs";

export function fileStore(file) {
  return { name: file, file,
           load: () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
           save: (o) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`; fs.writeFileSync(tmp, JSON.stringify(o, null, 1) + "\n"); fs.renameSync(tmp, file); return true; } catch { return false; } } };
}
// createIndexMemory with a file when one is named (the Node consumers' call shape: { file })
export const createFileIndexMemory = ({ file = null, store = null, ...rest } = {}) => createIndexMemory({ store: store ?? (file ? fileStore(file) : null), ...rest });
