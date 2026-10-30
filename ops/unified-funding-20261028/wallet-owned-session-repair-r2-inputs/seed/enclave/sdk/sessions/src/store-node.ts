import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deserialize, serialize } from "./grant.js";
import { base64url, fromBase64url } from "./keys.js";
import type { KeyStore, StoredSession } from "./store.js";

/** Agent key storage on disk: one 0600 JSON file per session under
 *  ~/.config/enclave/sessions (0700). It refuses a directory inside a git working
 *  tree, so a session key can't be committed by accident. */
export class FileStore implements KeyStore {
  readonly dir: string;
  constructor(dir?: string, opts: { allowInsideGit?: boolean } = {}) {
    this.dir = resolve(dir ?? process.env.ENCLAVE_SESSION_DIR ?? join(homedir(), ".config", "enclave", "sessions"));
    if (!opts.allowInsideGit && insideGitTree(this.dir))
      throw new Error(`refusing to store session keys inside a git working tree (${this.dir})`);
  }

  private file(id: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) && !/^0x[0-9a-f]{64}$/.test(id)) throw new Error(`bad session id ${id}`);
    return join(this.dir, `${id}.json`);
  }

  async save(rec: StoredSession) {
    if (rec.privateKey && !rec.pkcs8) throw new Error("FileStore needs the PKCS#8 export of the key");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const { privateKey: _k, ...plain } = rec;
    const f = this.file(rec.id);
    writeFileSync(f, serialize(plain), { mode: 0o600 });
    chmodSync(f, 0o600);
  }

  async load(id: string) {
    const f = this.file(id);
    if (!existsSync(f)) return null;
    if ((statSync(f).mode & 0o077) !== 0) throw new Error(`${f} is readable by others; chmod 600 it`);
    return deserialize<StoredSession>(readFileSync(f, "utf8"));
  }

  async list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((n) => n.endsWith(".json"))
      .map((n) => deserialize<StoredSession>(readFileSync(join(this.dir, n), "utf8")));
  }

  async remove(id: string) { rmSync(this.file(id), { force: true }); }

  /** The session commands use when none is named. */
  activeId(): string | null {
    const f = join(this.dir, "active");
    return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
  }

  setActive(id: string | null) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = join(this.dir, "active");
    if (id === null) rmSync(f, { force: true });
    else writeFileSync(f, id, { mode: 0o600 });
  }
}

function insideGitTree(dir: string): boolean {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

/** A whole session (key included) as one opaque string, for agents that keep
 *  secrets in environment variables: ENCLAVE_SESSION=<this>. */
export function exportSessionString(rec: StoredSession): string {
  if (!rec.pkcs8) throw new Error("only file-stored (exportable) sessions can be exported");
  const { privateKey: _k, ...plain } = rec;
  return base64url(new TextEncoder().encode(serialize(plain)));
}

export function importSessionString(s: string): StoredSession {
  const rec = deserialize<StoredSession>(new TextDecoder().decode(fromBase64url(s.trim())));
  if (rec.v !== 1 || !rec.pkcs8 || !rec.handle) throw new Error("ENCLAVE_SESSION is not an open session export");
  return rec;
}

/** Read-only store over ENCLAVE_SESSION. */
export class EnvStore implements KeyStore {
  private rec: StoredSession | null;
  constructor(value = process.env.ENCLAVE_SESSION) { this.rec = value ? importSessionString(value) : null; }
  async save() { throw new Error("ENCLAVE_SESSION is read-only"); }
  async load(id: string) { return this.rec && (this.rec.id === id || id === "env") ? this.rec : null; }
  async list() { return this.rec ? [this.rec] : []; }
  async remove() { throw new Error("ENCLAVE_SESSION is read-only; unset the variable"); }
}
