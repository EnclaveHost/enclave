"""Disposable PostgreSQL counterexample; no production, sockets on a private directory only."""
import subprocess,os,tempfile,time,pathlib,json,shutil,importlib.util,datetime
ROOT=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo')
base=ROOT/'work/resume-after-checkpoint-20261022/root-pg-drain-review'
pgroot=ROOT/'work/storage-host-role/pg18/root'; bin=pgroot/'usr/bin'
env={'PATH':str(bin)+':/usr/bin:/bin','LD_LIBRARY_PATH':str(pgroot/'usr/lib'),'LC_ALL':'C','TZ':'UTC'}
tmp=pathlib.Path(tempfile.mkdtemp(prefix='pgdrain-',dir='/tmp'));data=tmp/'data';sock=tmp/'sock';sock.mkdir()
server=writer=None;log=(base/'postgres.log').open('w');record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Actual PostgreSQL delayed update after client SIGKILL. Synthetic account table; NOT a reproduction of production indexd/controller shutdown.'}
args=[str(bin/'psql'),'-h',str(sock),'-U','probe','-d','postgres','-v','ON_ERROR_STOP=1','-Atc']
def q(sql):return subprocess.check_output(args+[sql],env={**env,'PGAPPNAME':'root-state'},text=True,stderr=subprocess.STDOUT,timeout=10).strip()
try:
 subprocess.run([str(bin/'initdb'),'-D',str(data),'-U','probe','--auth-local=trust','--auth-host=reject','--locale=C','-E','UTF8'],env=env,check=True,stdout=subprocess.DEVNULL,stderr=log,timeout=30)
 server=subprocess.Popen([str(bin/'postgres'),'-D',str(data),'-c','listen_addresses=','-c','unix_socket_directories='+str(sock),'-c','shared_buffers=8MB','-c','max_connections=10','-c','io_method=sync','-c','autovacuum=off','-c','max_worker_processes=0','-c','max_parallel_workers=0','-c','client_connection_check_interval=0'],env=env,stdout=log,stderr=log)
 for _ in range(50):
  if subprocess.run([str(bin/'pg_isready'),'-h',str(sock)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
  time.sleep(.1)
 else:raise RuntimeError('private PG failed readiness')
 record['postgres']=subprocess.check_output([str(bin/'postgres'),'--version'],env=env,text=True).strip()
 q("CREATE TABLE accounts (cas_mode boolean NOT NULL); INSERT INTO accounts VALUES(false); CREATE FUNCTION delayed_flip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(4); RETURN NEW; END $$; CREATE TRIGGER stall BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION delayed_flip();")
 writer=subprocess.Popen(args+['UPDATE accounts SET cas_mode=true;'],env={**env,'PGAPPNAME':'fixture-indexd'},stdout=subprocess.DEVNULL,stderr=log)
 for _ in range(60):
  if q("SELECT count(*) FROM pg_stat_activity WHERE application_name='fixture-indexd' AND wait_event='PgSleep'")=='1':break
  time.sleep(.05)
 else:raise RuntimeError('delayed update did not reach pg_sleep')
 writer.kill();writer.wait(timeout=5)
 record['clientExit']=writer.returncode
 record['casWhileClientGone']=int(q('SELECT count(*) FROM accounts WHERE cas_mode'))
 record['pendingBackend']=int(q("SELECT count(*) FROM pg_stat_activity WHERE application_name='fixture-indexd'"))
 pin='fbaecfced41da552a9e138082ecd0bd821c9e0f8'
 src=subprocess.check_output(['git','-C',str(ROOT/'work/resume-after-checkpoint-20261022/storage-write-release'),'show',pin+':package/tools/cutover.py'])
 frozen=base/'cutover-fbaecfc.py';frozen.write_bytes(src)
 spec=importlib.util.spec_from_file_location('frozen_cutover',frozen);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
 state='dbVersion=28\nunit.ActiveState=inactive\nunit.MainPID=0\nwriterPids=\nallowLiveStart=absent\nfencedAccounts=0\ncasEnrolledAccounts='+str(record['casWhileClientGone'])+'\ncontrollerSessions=\ntoolSessions=\n'
 record['decisionOnProcessOnlyBarrier']=mod.rollback_decision(state,True)['decision']
 for _ in range(70):
  if q("SELECT count(*) FROM pg_stat_activity WHERE application_name='fixture-indexd'")=='0':break
  time.sleep(.1)
 record['casAfterBackendFinished']=int(q('SELECT count(*) FROM accounts WHERE cas_mode'))
 record['observedCounterexample']=(record['clientExit']==-9 and record['casWhileClientGone']==0 and record['pendingBackend']==1 and record['decisionOnProcessOnlyBarrier']=='LEGACY_REDEPLOY_SAFE' and record['casAfterBackendFinished']==1)
finally:
 if writer is not None and writer.poll() is None:writer.kill();writer.wait(timeout=5)
 if server is not None:
  subprocess.run([str(bin/'pg_ctl'),'-D',str(data),'-m','fast','-w','-t','15','stop'],env=env,stdout=subprocess.DEVNULL,stderr=log,timeout=20)
  server.wait(timeout=10)
 log.close();shutil.rmtree(tmp)
 record['cleanup']={'postgresExited':server is None or server.poll() is not None,'tempRemoved':not tmp.exists()}
 (ROOT/'outputs/decentralization-audit/postgres-inflight-stop-counterexample-20261023.json').write_text(json.dumps(record,indent=2)+'\n')
 print(json.dumps(record))
assert record.get('observedCounterexample'), 'No confirmed counterexample; investigate result, do not claim one.'
