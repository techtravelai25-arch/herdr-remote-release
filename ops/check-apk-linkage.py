#!/usr/bin/env python3
"""Reject mixed APKs whose app constructor references have no DEX definition.

This narrow static packaging check catches stale incremental class combinations;
it does not replace an Android runtime launch test. Scans every DEX together.
"""
import struct,zipfile,sys

def scan(path):
    methods=set();defined=set();classes=set()
    with zipfile.ZipFile(path) as z:
      for n in z.namelist():
        if not n.endswith('.dex'):continue
        d=z.read(n)
        def u32(p):return struct.unpack_from('<I',d,p)[0]
        def uleb(p):
          v=0;s=0
          while True:
            b=d[p];p+=1;v|=(b&127)<<s;s+=7
            if b<128:return v,p
        ss,so=struct.unpack_from('<II',d,56); strings=[]
        for i in range(ss):
          p=u32(so+i*4);_,p=uleb(p);strings.append(d[p:d.index(b'\0',p)].decode('utf8',errors='replace'))
        ts,to=struct.unpack_from('<II',d,64);types=[strings[u32(to+i*4)] for i in range(ts)]
        ps,po=struct.unpack_from('<II',d,72);protos=[]
        for i in range(ps):
          p=po+i*12;r=types[u32(p+4)];q=u32(p+8);args=[]
          if q:args=[types[struct.unpack_from('<H',d,q+4+j*2)[0]] for j in range(u32(q))]
          protos.append('('+''.join(args)+')'+r)
        ms,mo=struct.unpack_from('<II',d,88);local=[]
        for i in range(ms):
          owner,proto,name=struct.unpack_from('<HHI',d,mo+i*8);key=(types[owner],strings[name],protos[proto]);local.append(key)
          if types[owner].startswith('Ldev/herdr/remote/'):methods.add(key)
        cs,co=struct.unpack_from('<II',d,96)
        for i in range(cs):
          p=co+i*32;owner=types[u32(p)];classes.add(owner);q=u32(p+24)
          if not q:continue
          counts=[]
          for j in range(4):v,q=uleb(q);counts.append(v)
          for j in range(counts[0]+counts[1]):_,q=uleb(q);_,q=uleb(q)
          for count in counts[2:]:
            idx=0
            for j in range(count):
              diff,q=uleb(q);idx+=diff;_,q=uleb(q);_,q=uleb(q);defined.add(local[idx])
    missing=sorted(m for m in methods if m[1]=='<init>' and m not in defined)
    print(path,'missing app constructor definitions:',len(missing))
    for m in missing[:20]:print(m)
    return 1 if missing else 0

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: check-apk-linkage.py path/to/app.apk')
    raise SystemExit(scan(sys.argv[1]))
