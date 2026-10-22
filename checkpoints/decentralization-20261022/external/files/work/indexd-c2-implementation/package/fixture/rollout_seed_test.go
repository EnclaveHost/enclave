package postgres

// ROLLOUT FIXTURE SEEDER (work/indexd-replica-rollout, test-only file in a COPY of stock indexd v0.6.0 ddaf24b).
// Creates a stock v0.6.0 (db_version 26) database with realistic acknowledged metadata, through the stock store's
// own code paths, so the replica rollout's upgrade/backup/restore/rollback can be verified on real rows. It runs
// only with ROLLOUT_SEED=1 and never drops anything. The disposable app key is written (hex seed) to
// ROLLOUT_KEY_FILE with mode 0600 and never printed.

import (
	"context"
	"encoding/hex"
	"os"
	"strconv"
	"testing"
	"time"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/contracts"
	"go.sia.tech/indexd/hosts"
	"go.sia.tech/indexd/sharing"
	"go.sia.tech/indexd/slabs"
	"go.uber.org/zap"
	"lukechampine.com/frand"
)

func TestRolloutSeed(t *testing.T) {
	if os.Getenv("ROLLOUT_SEED") != "1" {
		t.Skip("ROLLOUT_SEED=1 not set")
	}
	port, err := strconv.Atoi(os.Getenv("ROLLOUT_PG_PORT"))
	if err != nil {
		t.Fatal("ROLLOUT_PG_PORT")
	}
	ci := ConnectionInfo{Host: "127.0.0.1", Port: port, User: os.Getenv("POSTGRES_USER"), Password: os.Getenv("POSTGRES_PASSWORD"),
		Database: os.Getenv("ROLLOUT_DB"), SSLMode: "disable"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	store, err := NewStore(ctx, ci, contracts.DefaultMaintenanceSettings, hosts.DefaultUsabilitySettings, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if v := getDBVersion(ctx, store.pool); v != int64(len(migrations)+1) {
		t.Fatalf("stock schema version %d", v)
	}
	var n int
	if err := store.pool.QueryRow(ctx, `SELECT COUNT(*) FROM accounts`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("refusing to seed a non-empty database (%d accounts, %v)", n, err)
	}

	// the deployment's signed account identity: a disposable fixture app key
	var seed [32]byte
	frand.Read(seed[:])
	sk := types.NewPrivateKeyFromSeed(seed[:])
	if err := os.WriteFile(os.Getenv("ROLLOUT_KEY_FILE"), []byte(hex.EncodeToString(seed[:])), 0o600); err != nil {
		t.Fatal(err)
	}
	acc := proto.Account(sk.PublicKey())
	store.addTestAccount(t, sk.PublicKey())

	hk := store.addTestHost(t)
	store.addTestContract(t, hk)

	var params []slabs.SlabPinParams
	for i := 0; i < 3; i++ {
		params = append(params, slabs.SlabPinParams{EncryptionKey: frand.Entropy256(), MinShards: 1,
			Sectors: []slabs.PinnedSector{{Root: frand.Entropy256(), HostKey: hk}}})
	}
	if _, err := store.PinSlabs(acc, time.Time{}, params...); err != nil {
		t.Fatal(err)
	}
	var objs []slabs.SealedObject
	for i := 0; i < 12; i++ {
		o := slabs.SealedObject{
			EncryptedDataKey:     frand.Bytes(72),
			EncryptedMetadataKey: frand.Bytes(72),
			EncryptedMetadata:    frand.Bytes(40),
			Slabs:                []slabs.SlabSlice{params[i%3].Slice(uint32(i)*4096, 4096)},
		}
		o.Sign(sk)
		if err := store.PinObject(acc, o.PinRequest()); err != nil {
			t.Fatal(err)
		}
		objs = append(objs, o)
		if i == 5 {
			store.publishEvents(t) // objects 0-5 published, 6-11 not
		}
	}
	if err := store.DeleteObject(acc, objs[3].ID()); err != nil { // a tombstone
		t.Fatal(err)
	}
	if err := store.BlockObject(objs[7].ID(), "rollout fixture"); err != nil { // an operator block
		t.Fatal(err)
	}
	nonce := sharing.Nonce(frand.Bytes(32))
	sharePriv := sharing.DeriveSharingKey(sk, nonce)
	if _, err := store.AddSharingKey(acc, sharing.KeyRequest{PublicKey: sharePriv.PublicKey(), Nonce: nonce, Description: "rollout fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := store.AddSharedObject(acc, sharePriv.PublicKey(), sharing.SharedObjectRequest{ObjectID: objs[1].ID(),
		EncryptedDataKey: frand.Bytes(sharing.EncryptionKeySize), DataSignature: types.Signature(frand.Bytes(64)),
		MetadataSignature: types.Signature(frand.Bytes(64))}); err != nil {
		t.Fatal(err)
	}
	t.Logf("seeded: 1 account, 1 host, 1 contract, %d slabs, %d objects (1 deleted, 1 blocked), 1 sharing key", len(params), len(objs))
}
