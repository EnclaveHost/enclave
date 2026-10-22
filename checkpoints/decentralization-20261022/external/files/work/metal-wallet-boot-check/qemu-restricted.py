#!/usr/bin/python3
import os,sys
args=sys.argv[1:]
for i,a in enumerate(args):
 if a=='-netdev':
  if not args[i+1].startswith('user,id=net0'): raise SystemExit('unexpected network backend')
  args[i+1]=args[i+1]+',restrict=on'
os.execv('/usr/sbin/qemu-system-x86_64',['qemu-system-x86_64',*args])
