package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"enclave.host/isolation/m2/appconfig"
	"enclave.host/isolation/m2/bootstrap"
)

// The checkpoint endpoint is the front's only where a direct SEV-SNP startup verified its lease's history (main.go);
// everywhere else the path stays the app's, as before. The startup loads checkpoints only when the owner's config needs
// the writer authority (bootstrap.go directFacts), and a Shield partition never does (shield_direct_custody.go).
func TestCheckpointPathStaysTheAppsWithoutAProducer(t *testing.T) {
	reached := false
	f := &front{app: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true })}
	f.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", bootstrap.CheckpointPath, nil))
	if !reached {
		t.Fatal("the path was taken from the app with no producer")
	}
}

func TestCheckpointsLoadOnlyForTheWriterAuthority(t *testing.T) {
	called := false
	facts, err := directFacts(context.Background(), nil, `{"plain":"config"}`, snpIsolation, func(context.Context, *bootstrap.Authorization) { called = true })
	if err != nil || called || facts[appconfig.FactInstanceIsolation] != snpIsolation {
		t.Fatalf("facts %v err %v called %v", facts, err, called)
	}
}
