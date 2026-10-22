package main
import("encoding/json";"fmt";"net/http";"os";"time")
func main(){
 c:=http.Client{Timeout:5*time.Second};out:=map[string]any{}
 for _,path:=range []string{"state","consensus/state","stats/objects","stats/contracts","wallet"}{
  req,_:=http.NewRequest("GET","http://127.0.0.1:9980/api/"+path,nil);req.SetBasicAuth("","offline-rehearsal-only")
  r,e:=c.Do(req);if e!=nil{fmt.Fprintln(os.Stderr,"API unavailable:",path);os.Exit(1)}
  if r.StatusCode!=200{fmt.Fprintln(os.Stderr,"API status:",path,r.StatusCode);os.Exit(1)}
  var value map[string]any;e=json.NewDecoder(r.Body).Decode(&value);r.Body.Close();if e!=nil{fmt.Fprintln(os.Stderr,"invalid JSON:",path);os.Exit(1)}
  switch path{
  case "state": out["state"]=map[string]any{"version":value["version"],"network":value["network"],"scanHeight":value["scanHeight"],"syncHeight":value["syncHeight"],"explorer":value["explorer"]}
  case "consensus/state":out["consensusIndex"]=value["index"]
  case "wallet":out["walletLoaded"]=value["address"]!=nil
  default:out[path]=value
  }
 }
 json.NewEncoder(os.Stdout).Encode(out)
}
