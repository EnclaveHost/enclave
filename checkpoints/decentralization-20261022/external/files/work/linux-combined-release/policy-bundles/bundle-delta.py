# old vs new minified bundle: strip the common prefix/suffix; the differing middle must be ONLY the PRODUCTION_MIRRORS literal.
import sys,re
old,new=open(sys.argv[1],encoding='utf8').read(),open(sys.argv[2],encoding='utf8').read()
MIRRORS=["https://134.199.235.187/platform-policy","https://134.209.248.172/platform-policy","https://165.245.191.129/platform-policy","https://146.190.246.39/platform-policy"]
p=0
while p<min(len(old),len(new)) and old[p]==new[p]: p+=1
s=0
while s<min(len(old),len(new))-p and old[-1-s]==new[-1-s]: s+=1
a,b=old[p:len(old)-s],new[p:len(new)-s]
ctx=old[max(0,p-60):p]
print(sys.argv[3],'DIFF-AT',p,'context ...'+ctx+'|  old:',repr(a),' new:',repr(b))
# the region must be: nothing -> the four quoted URLs comma-separated (array was []), and the context must open the array
assert a=='' and ctx.endswith('Object.freeze(['), 'the bundle changed beyond the empty mirror array'
assert b==','.join('"'+m+'"' for m in MIRRORS), 'the inserted text is not exactly the four mirrors'
print(sys.argv[3],'BUNDLE-DELTA-IS-ONLY-PRODUCTION_MIRRORS ([] -> 4 reviewed routes)')
