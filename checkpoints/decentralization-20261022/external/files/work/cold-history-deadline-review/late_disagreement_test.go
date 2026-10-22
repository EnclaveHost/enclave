package bootstrap

import (
    "context"
    "errors"
    "strings"
    "testing"
    "time"
)

func TestHistoryCannotDiscardCompletedLateContradiction(t *testing.T) {
    r := &Reader{ledger: "0x" + strings.Repeat("ab",20)}
    id := "0x" + strings.Repeat("11",32)
    claim := rpcLog{Address:r.ledger, Topics:[]string{topicClaimed,id,"0x"+strings.Repeat("22",32),"0x"+strings.Repeat("0",24)+strings.Repeat("33",20)},
        Data:"0x"+strings.Repeat("0",63)+"1"+strings.Repeat("0",64),BlockNumber:"0x10",BlockHash:"0x"+strings.Repeat("44",32),LogIndex:"0x0"}
    a := fakeSource("rpc.one.example", []rpcLog{claim}, nil, 0, nil)
    b := fakeSource("rpc.two.test", []rpcLog{claim}, nil, 0, nil)
    c := fakeSource("rpc.three.invalid", nil, nil, 0, nil)
    call := c.call
    c.call = func(ctx context.Context, method string, params any, out any) error {
        // A response can already be in flight when cancellation reaches the transport.
        // Ignore cancellation to deliver it; the caller must inspect the drained response.
        time.Sleep(30*time.Millisecond)
        return call(ctx,method,params,out)
    }
    budgets := map[string]*budget{a.name:{max:400},b.name:{max:400},c.name:{max:400}}
    _, err := r.agreedLogs(context.Background(), []endpoint{a,b,c}, id, 1,100,budgets,nil)
    var ae *AuthorityError
    if !errors.As(err,&ae) || ae.Code!="disagree" {
        t.Fatalf("completed contradictory history was discarded: %v",err)
    }
}
