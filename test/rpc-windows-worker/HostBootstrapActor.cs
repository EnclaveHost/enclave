// Fixed, finite inert replacement for Node and TPM ONLY in the separate hosted
// fixture executable. Does not run JS, use hardware/key material or create children.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
public static class HostBootstrapActor {
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=131072};
 static byte[] Read(Stream s,int n){byte[] b=new byte[n];int at=0;while(at<n){int got=s.Read(b,at,n-at);if(got<=0)throw new IOException("Fixture EOF");at+=got;}return b;}
 static byte[] Frame(Stream s,out int lane){byte[] h=Read(s,5);lane=h[0];int n=(h[1]<<24)|(h[2]<<16)|(h[3]<<8)|h[4];if(lane>2||n<1||n>131072)throw new IOException("Fixture frame");return Read(s,n);}
 static void Send(Stream s,int lane,byte[] b){s.Write(new byte[]{(byte)lane,(byte)(b.Length>>24),(byte)(b.Length>>16),(byte)(b.Length>>8),(byte)b.Length},0,5);s.Write(b,0,b.Length);s.Flush();}
 static void Text(Stream s,int lane,string text){Send(s,lane,Encoding.UTF8.GetBytes(text));}
 public static int Main(string[] args){
  // Independent fixture self-bound; actual tests require earlier native observer
  // deadline/death, never infer termination from this process's own timer.
  new Thread(delegate(){Thread.Sleep(8000);Environment.Exit(127);}){IsBackground=true}.Start();
  try{
   string root=Environment.CurrentDirectory,mode=File.ReadAllText(Path.Combine(root,"fixture.mode"));
   string name=Path.GetFileName(Process.GetCurrentProcess().MainModule.FileName);
   if(name=="tpm.exe"){
    if(args.Length!=0)return 64;Console.WriteLine("ready tpmattest/1");Console.Out.Flush();
    string line;while((line=Console.ReadLine())!=null){
     if(line=="block"){
      using(var f=new FileStream(Path.Combine(root,"fixture.blocked.pending"),FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.WriteByte(1);f.Flush(true);}
      File.Move(Path.Combine(root,"fixture.blocked.pending"),Path.Combine(root,"fixture.blocked"));
      Thread.Sleep(8000);return 2;
     }
     if(line!="keys")return 3;Console.WriteLine("ek fixture\nok");Console.Out.Flush();
    }return 0;
   }
   if(name!="node.exe"||args.Length!=3||args[0]!="--no-addons"||args[1]!="--max-old-space-size=48"||!args[2].EndsWith("\\rpc\\host\\windows-entry.mjs",StringComparison.Ordinal))return 64;
   while(!File.Exists(Path.Combine(root,"fixture.release")))Thread.Sleep(5);
   Stream input=Console.OpenStandardInput(),output=Console.OpenStandardOutput();
   if(mode=="malformed"){output.Write(new byte[]{3,0,0,0,1,0},0,6);output.Flush();Thread.Sleep(8000);return 4;}
   Text(output,0,"clock");int lane;byte[] receipt=Frame(input,out lane);if(lane!=0)return 5;
   var clock=(System.Collections.Generic.Dictionary<string,object>)Json.DeserializeObject(Encoding.UTF8.GetString(receipt));
   if((string)clock["schema"]!="rpc-native-clock/1"||(string)clock["privateKeyPem"]!="CI_ONLY_NOT_A_PRIVATE_KEY")return 6;
   if(mode=="blocked-tpm"||mode=="observer-loss"){Text(output,2,"block\n");Thread.Sleep(8000);return 7;}
   byte[] part=new byte[25000];for(int i=0;i<part.Length;i++)part[i]=(byte)'m';for(int i=0;i<4;i++)Send(output,1,part);
   Text(output,2,"keys\n");bool monitor=false,tpm=false;string t="";
   while(!monitor||!tpm){string text=Encoding.UTF8.GetString(Frame(input,out lane));if(lane==1){if(text!="monitor-ok\n")return 8;monitor=true;}else if(lane==2){t=(t+text).Replace("\r\n","\n");if(t.Length>1024)return 9;tpm=t.Contains("\nok\n");}else return 10;}
   Text(output,0,"enroll\n{\"fixture\":true}");string offer=Encoding.UTF8.GetString(Frame(input,out lane));
   if(lane!=0||offer!="{\"fixture\":true}")return 11;
   Text(output,0,"acquisition-requested");Thread.Sleep(8000);return 12;
  }catch{return 1;}
 }
}
