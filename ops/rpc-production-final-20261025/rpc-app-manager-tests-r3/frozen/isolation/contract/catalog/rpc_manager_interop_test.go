package catalog

import (
 "encoding/json"
 "os"
 "path/filepath"
 "testing"
)

// Writes only a public mapping. Used by the new Windows manager interoperability
// qualification; this does not launch, attest or admit a native VM.
func TestRPCManagerInteropVector(t *testing.T) {
 dir:=os.Getenv("RPC_MAPPING_VECTOR_DIR")
 if dir=="" {t.Skip("explicit public vector directory required")}
 m,b,err:=MapRPC(rpcRecord(),componentPreamble)
 if err!=nil {t.Fatal(err)}
 raw,err:=json.Marshal(m);if err!=nil {t.Fatal(err)}
 for name,data:=range map[string][]byte{"rpc-mapping.json":raw,"rpc-bundle.bin":b} {
  f,e:=os.OpenFile(filepath.Join(dir,name),os.O_CREATE|os.O_EXCL|os.O_WRONLY,0600)
  if e!=nil {t.Fatal(e)}
  if _,e=f.Write(data);e!=nil {t.Fatal(e)}
  if e=f.Sync();e!=nil {t.Fatal(e)}
  if e=f.Close();e!=nil {t.Fatal(e)}
 }
}
