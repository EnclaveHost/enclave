import json,sys
for f in sys.argv[1:]:
    d=json.load(open(f)); print('=====',f)
    for n,r in d.items():
        print('--',n,'exit',r['exit'],'kept',[k.split('/')[0]+('/cr' if 'network/' in k else '') for k,v in r['kept'].items() if v])
        print('   ev:',' | '.join(r['events']))
        for e in r['emits']: print('   ',e['step'],e['state'],e['message'][:220])
        if r['stderr']: print('   STDERR',r['stderr'].split('\n')[-2][-200:])
