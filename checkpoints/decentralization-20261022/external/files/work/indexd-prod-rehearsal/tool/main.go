// Command rehearsaltool exercises the indexd-fence RELEASE source's own store code (work/indexd-replica-rollout/src,
// the source of release binary 61413110...) against a DISPOSABLE restored copy of production metadata, inside the
// rehearsal's network namespace (loopback only). It prints COUNTS AND BOOLEANS ONLY: never a key, object, metadata
// value, account identifier or credential.
//
//	rehearsaltool migrate         apply the release migrations (26 -> 27) exactly as the binary does at startup
//	rehearsaltool fence-exercise  store-level fixture fence on every real account: backfill, seq listing, refusal
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
	case "fence-exercise":
		if v := version(); v != 27 {
			fail(fmt.Sprintf("expected db_version 27, found %d", v))
		}
		s, err := postgres.NewStore(ctx, ci, contracts.DefaultMaintenanceSettings, hosts.DefaultUsabilitySettings, zap.NewNop())
		check(err)
		defer s.Close()
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
		allOK := true
		for i, a := range accts {
			r := map[string]any{"account": i} // an index, never the key
			var events, deleted, live, blockedLive, liveUnblocked int64
			check(conn.QueryRow(ctx, `SELECT COUNT(*), COUNT(*) FILTER (WHERE was_deleted) FROM object_events WHERE account_id = $1`, a.id).Scan(&events, &deleted))
			check(conn.QueryRow(ctx, `SELECT COUNT(*), COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM blocked_objects b WHERE b.object_key = o.object_key))
				FROM objects o WHERE o.account_id = $1`, a.id).Scan(&live, &blockedLive))
			liveUnblocked = live - blockedLive
			r["sqlEvents"], r["sqlDeletedEvents"], r["sqlLiveObjects"], r["sqlBlockedLiveObjects"] = events, deleted, live, blockedLive

			var tok accounts.Fence // a FIXTURE token: gen 0x7e.., counter 1, random iid (nothing production-derived)
			binary.BigEndian.PutUint64(tok[:8], 0x7e<<48|1)
			binary.BigEndian.PutUint64(tok[8:16], 1)
			rand.Read(tok[16:])
			t0 := time.Now()
			receipt, head, err := s.RaiseFence(proto.Account(a.pk), tok)
			check(err)
			r["raiseSeconds"] = time.Since(t0).Seconds()
			r["backfillHead"] = head

			// page the whole sequence listing (1000 per page) and check it against SQL
			var after uint64
			var n, nDeleted, nBlocked, nWithObject int64
			contiguous := true
			for {
				h, page, err := s.ListObjectsSeq(proto.Account(a.pk), after, 1000)
				check(err)
				if h != head {
					contiguous = false
				}
				if len(page) == 0 {
					break
				}
				for _, ev := range page {
					n++
					if ev.Seq != uint64(n) {
						contiguous = false
					}
					switch {
					case ev.Deleted:
						nDeleted++
					case ev.Blocked:
						nBlocked++
					}
					if ev.Object != nil {
						nWithObject++
					}
				}
				after = page[len(page)-1].Seq
			}
			r["listedEvents"], r["listedDeleted"], r["listedBlocked"], r["listedWithObject"], r["seqContiguous"] = n, nDeleted, nBlocked, nWithObject, contiguous
			st, err := s.AccountFence(proto.Account(a.pk))
			check(err)
			r["fenceStateHeadMatches"] = st.Seq == head && st.Fence != nil && *st.Fence == tok

			// an unfenced mutation on the now-fenced real account is refused and changes nothing
			var key []byte
			err = conn.QueryRow(ctx, `SELECT object_key FROM objects WHERE account_id = $1 ORDER BY id LIMIT 1`, a.id).Scan(&key)
			if err == nil {
				var k types.Hash256
				copy(k[:], key)
				derr := s.DeleteObjectFenced(proto.Account(a.pk), nil, k)
				var fe *accounts.FencedError
				var liveAfter int64
				check(conn.QueryRow(ctx, `SELECT COUNT(*) FROM objects WHERE account_id = $1`, a.id).Scan(&liveAfter))
				r["unfencedDeleteRefused"] = errors.As(derr, &fe) && fe.Current != nil && *fe.Current == tok
				r["liveObjectsUnchangedAfterRefusal"] = liveAfter == live
				// the exact credential would pass the check: verified without mutating, by a wrong-receipt refusal
				wrong := accounts.Credential{Fence: tok, Receipt: receipt}
				wrong.Receipt[0] ^= 1
				werr := s.DeleteObjectFenced(proto.Account(a.pk), &wrong, k)
				r["wrongReceiptRefused"] = errors.As(werr, &fe)
			}
			ok := head == uint64(events) && n == events && nDeleted == deleted && nBlocked <= blockedLive && nWithObject == liveUnblocked &&
				contiguous && r["fenceStateHeadMatches"] == true && r["unfencedDeleteRefused"] != false && r["liveObjectsUnchangedAfterRefusal"] != false &&
				r["wrongReceiptRefused"] != false
			r["ok"] = ok
			allOK = allOK && ok
			results = append(results, r)
		}
		out["accounts"] = len(accts)
		out["results"] = results
		out["ok"] = allOK && len(accts) > 0
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
	fmt.Fprintln(os.Stderr, "rehearsaltool:", msg)
	os.Exit(1)
}
