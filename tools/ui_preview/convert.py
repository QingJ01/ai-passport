from pathlib import Path
import struct,zlib,json,hashlib
out=Path(__file__).resolve().parent
root=out.parents[1]
def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
meta=json.loads((out/'source.json').read_text())
for name in ('now','now-live','tasks','menu','usage','inbox','confirm','action','now-claude','tasks-claude','desk','toast','desk-claude','link','wifi'):
 rgb=(out/(name+'.rgb')).read_bytes()
 assert len(rgb)==240*320*3
 scan=b''.join(b'\0'+rgb[y*720:(y+1)*720] for y in range(320))
 png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',240,320,8,2,0,0,0))
 png+=chunk(b'tEXt',b'Description\0HOST LVGL RENDER; '+meta[name].encode())
 png+=chunk(b'tEXt',b'SourceSHA256\0'+meta['main_sha256'].encode())
 png+=chunk(b'IDAT',zlib.compress(scan,9))+chunk(b'IEND',b'')
 p=root/'docs/assets'/('agent-pet-ui-'+name+'.png')
 p.write_bytes(png)
 print(p,len(png),hashlib.sha256(png).hexdigest())
