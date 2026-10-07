import type { KeyStore, StoredSession } from "./store.js";
/** Agent key storage on disk: one 0600 JSON file per session under
 *  ~/.config/enclave/sessions (0700). It refuses a directory inside a git working
 *  tree, so a session key can't be committed by accident. */
export declare class FileStore implements KeyStore {
    readonly dir: string;
    constructor(dir?: string, opts?: {
        allowInsideGit?: boolean;
    });
    private file;
    save(rec: StoredSession): Promise<void>;
    load(id: string): Promise<StoredSession | null>;
    list(): Promise<StoredSession[]>;
    remove(id: string): Promise<void>;
    /** The session commands use when none is named. */
    activeId(): string | null;
    setActive(id: string | null): void;
}
/** A whole session (key included) as one opaque string, for agents that keep
 *  secrets in environment variables: ENCLAVE_SESSION=<this>. */
export declare function exportSessionString(rec: StoredSession): string;
export declare function importSessionString(s: string): StoredSession;
/** Read-only store over ENCLAVE_SESSION. */
export declare class EnvStore implements KeyStore {
    private rec;
    constructor(value?: string | undefined);
    save(): Promise<void>;
    load(id: string): Promise<StoredSession | null>;
    list(): Promise<StoredSession[]>;
    remove(): Promise<void>;
}
