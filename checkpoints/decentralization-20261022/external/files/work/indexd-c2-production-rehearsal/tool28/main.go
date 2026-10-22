// Command c2tool exercises the G-C2 R2 source's own store code (work/indexd-c2-implementation/src, the source of
// release e6e812fd...) against a DISPOSABLE restored copy of production metadata, inside the rehearsal's isolated
// network namespace (the PostgreSQL container's loopback only). Derived from the earlier rehearsaltool
// (work/indexd-prod-rehearsal/tool, 2ff37377...). Prints COUNTS AND BOOLEANS ONLY: never a key, object, metadata
// value, account identifier or credential.
//
//	c2tool migrate          apply the G-C2 migrations exactly as the binary does at startup (27 -> 28)
//	c2tool c2-exercise      on EVERY real account: enrol (fixture fence, mode cas), then the C2 refusals WITHOUT
//	                        applying any mutation: stock 409, v3 412 mode, stale-head CAS 412 seq, advancing v4
//	                        without sq 400-class, raise without mode 412 mode; live objects/events unchanged
//
// Connection: env RH_PG_USER, RH_PG_PASSWORD (fixture), RH_DB; host 127.0.0.1:5432 (the isolated namespace).
package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/contracts"
	"go.sia.tech/indexd/hosts"
	"go.sia.tech/indexd/persist/postgres"
	"go.uber.org/zap"
)

func main() {
	ci := postgres.ConnectionInfo{Host: "127.0.0.1", Port: 5432, User: os.Getenv("RH_PG_USER"), Password: os.Getenv("RH_PG_PASSWORD"),
		Database: os.Getenv("RH_DB"), SSLMode: "disable"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	conn, err := pgx.Connect(ctx, ci.String())
	check(err)
	defer conn.Close(ctx)
	version := func() (v int64) {
		check(conn.QueryRow(ctx, `SELECT db_version FROM global_settings`).Scan(&v))
		return
	}
	out := map[string]any{"step": os.Args[1]}

	switch os.Args[1] {
	case "migrate":
		out["dbVersionBefore"] = version()
		t0 := time.Now()
		s, err := postgres.NewStore(ctx, ci, contracts.DefaultMaintenanceSettings, hosts.DefaultUsabilitySettings, zap.NewNop())
		check(err)
		out["migrateSeconds"] = time.Since(t0).Seconds()
		s.Close()
		out["dbVersionAfter"] = version()
	case "c2-exercise":
		if v := version(); v != 28 {
			fail(fmt.Sprintf("expected db_version 28, found %d", v))
		}
		s, err := postgres.NewStore(ctx, ci, contracts.DefaultMaintenanceSettings, hosts.DefaultUsabilitySettings, zap.NewNop())
		check(err)
		defer s.Close()
		var enrolledBefore int64
		check(conn.QueryRow(ctx, `SELECT COUNT(*) FROM accounts WHERE cas_mode OR fence IS NOT NULL OR last_op IS NOT NULL`).Scan(&enrolledBefore))
		out["accountsFencedOrEnrolledBefore"] = enrolledBefore
		rows, err := conn.Query(ctx, `SELECT id, public_key FROM accounts WHERE deleted_at IS NULL ORDER BY id`)
		check(err)
		type acct struct {
			id int64
			pk types.PublicKey
		}
		var accts []acct
		for rows.Next() {
			var a acct
			var pk []byte
			check(rows.Scan(&a.id, &pk))
			copy(a.pk[:], pk)
			accts = append(accts, a)
		}
		rows.Close()
		var results []map[string]any
		allOK := enrolledBefore == 0
		for i, a := range accts {
			r := map[string]any{"account": i} // an index, never the key
			acc := proto.Account(a.pk)
			counts := func() (events, live int64) {
				check(conn.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM object_events WHERE account_id = $1), (SELECT COUNT(*) FROM objects WHERE account_id = $1)`, a.id).Scan(&events, &live))
				return
			}
			events, live := counts()
			r["sqlEvents"], r["sqlLiveObjects"] = events, live

			var tok accounts.Fence // a FIXTURE token: gen 0x7d.., counter 1, random iid (nothing production-derived)
			binary.BigEndian.PutUint64(tok[:8], 0x7d<<48|1)
			binary.BigEndian.PutUint64(tok[8:16], 1)
			rand.Read(tok[16:])
			t0 := time.Now()
			receipt, head, err := s.RaiseFence(acc, tok, accounts.ModeCAS)
			check(err)
			r["enrolSeconds"], r["backfillHead"] = time.Since(t0).Seconds(), head
			st, err := s.AccountFence(acc)
			check(err)
			r["stateModeCas"] = st.Mode != nil && *st.Mode == accounts.ModeCAS
			r["stateHeadMatches"] = st.Seq == head && uint64(events) == head
			r["noLastOp"] = st.LastOp == nil
			cred := accounts.Credential{Fence: tok, Receipt: receipt}

			// the refusals, on a real key: NONE may apply anything
			var key []byte
			if err := conn.QueryRow(ctx, `SELECT object_key FROM objects WHERE account_id = $1 ORDER BY id LIMIT 1`, a.id).Scan(&key); err == nil {
				var k types.Hash256
				copy(k[:], key)
				var fe *accounts.FencedError
				var ce *accounts.CASConflictError
				r["stockDeleteRefused409"] = errors.As(s.DeleteObjectFenced(acc, nil, k), &fe) && fe.Current != nil && *fe.Current == tok
				v3 := cred
				r["v3DeleteRefused412mode"] = errors.As(s.DeleteObjectFenced(acc, &v3, k), &ce) && ce.Kind == "mode"
				stale := cred
				var op accounts.OpID
				rand.Read(op[:])
				stale.CAS = &accounts.CASRequest{HasSq: true, Sq: head + 5, Op: op}
				err = s.DeleteObjectFenced(acc, &stale, k)
				r["staleHeadRefused412seq"] = errors.As(err, &ce) && ce.Kind == "seq" && ce.Seq != nil && *ce.Seq == head
				noSq := cred
				noSq.CAS = &accounts.CASRequest{Op: op}
				r["advancingWithoutSqRefused"] = errors.Is(s.DeleteObjectFenced(acc, &noSq, k), accounts.ErrCASSeqRequired)
			}
			higher := tok
			binary.BigEndian.PutUint64(higher[8:16], 2)
			_, _, rerr := s.RaiseFence(acc, higher, "")
			var ce *accounts.CASConflictError
			r["plainRaiseRefused412mode"] = errors.As(rerr, &ce) && ce.Kind == "mode"
			st2, err := s.AccountFence(acc)
			check(err)
			r["fenceUnchangedAfterRefusedRaise"] = st2.Fence != nil && *st2.Fence == tok && st2.Seq == head
			e2, l2 := counts()
			r["eventsAndLiveObjectsUnchanged"] = e2 == events && l2 == live
			ok := r["stateModeCas"] == true && r["stateHeadMatches"] == true && r["noLastOp"] == true && r["plainRaiseRefused412mode"] == true &&
				r["fenceUnchangedAfterRefusedRaise"] == true && r["eventsAndLiveObjectsUnchanged"] == true &&
				r["stockDeleteRefused409"] != false && r["v3DeleteRefused412mode"] != false && r["staleHeadRefused412seq"] != false &&
				r["advancingWithoutSqRefused"] != false
			r["ok"] = ok
			allOK = allOK && ok
			results = append(results, r)
		}
		out["accounts"], out["results"], out["ok"] = len(accts), results, allOK && len(accts) > 0
	default:
		fail("unknown step")
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
	if ok, present := out["ok"]; present && ok != true {
		os.Exit(1)
	}
}

func check(err error) {
	if err != nil {
		fail(err.Error())
	}
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "c2tool:", msg)
	os.Exit(1)
}
