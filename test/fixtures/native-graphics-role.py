"""Actual desktop GL/Vulkan rendering inside the measured native platform.
Synthetic lifecycle client only; does not claim owner release or masked GPU work.
"""
import ctypes as c
import hashlib,json,os,re,subprocess,time
from pathlib import Path
assert os.getuid()==os.geteuid()==1000
status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
for key in ['CapEff','CapPrm','CapBnd','CapAmb']:assert int(status[key],16)==0
assert status['NoNewPrivs'].strip()=='1' and status['Seccomp'].strip()=='2'
assert not Path('/dev/dri').exists() and not Path('/dev/nvidia0').exists()
assert os.environ['GALLIUM_DRIVER']=='zink' and os.environ['DISPLAY']==':0'
lib=Path('/opt/shield/mesa/lib/libvulkan_lvp.so');gallium=lib.with_name('libgallium-25.0.7.so')
assert hashlib.sha256(lib.read_bytes()).hexdigest()=='aa600783f4e5d7e8763a5b0159fb90309d8deb19d9ece27ed9d5d6f266fc95a8'
assert hashlib.sha256(gallium.read_bytes()).hexdigest()=='590f9bf762f857492ffdfff75acadb849cd47e307634e8efebde13bdd7fb0b80'
def command(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=20);assert p.returncode==0,(args,p.stderr);return p.stdout
vk=command(['vulkaninfo','--summary']);gl=command(['glxinfo','-B'])
assert 'PHYSICAL_DEVICE_TYPE_CPU' in vk and 'llvmpipe' in vk
assert 'zink Vulkan' in gl and '4.6' in gl and 'Accelerated: no' in gl
x=c.CDLL('libX11.so.6')
def bind(n,r,*a):
 f=getattr(x,n);f.restype=r;f.argtypes=list(a);return f
ptr=c.c_void_p;ul=c.c_ulong;ui=c.c_uint;ip=c.POINTER(c.c_int);up=c.POINTER(ui);ulp=c.POINTER(ul)
open_display=bind('XOpenDisplay',ptr,c.c_char_p)
geometry=bind('XGetGeometry',c.c_int,ptr,ul,ulp,ip,ip,up,up,up,up)
class Attributes(c.Structure):
 _fields_=[('x',c.c_int),('y',c.c_int),('width',c.c_int),('height',c.c_int),('border_width',c.c_int),('depth',c.c_int),
  ('visual',ptr),('root',ul),('window_class',c.c_int),('bit_gravity',c.c_int),('win_gravity',c.c_int),('backing_store',c.c_int),
  ('backing_planes',ul),('backing_pixel',ul),('save_under',c.c_int),('colormap',ul),('map_installed',c.c_int),('map_state',c.c_int),
  ('all_event_masks',c.c_long),('your_event_mask',c.c_long),('do_not_propagate_mask',c.c_long),('override_redirect',c.c_int),('screen',ptr)]
attributes=bind('XGetWindowAttributes',c.c_int,ptr,ul,c.POINTER(Attributes))
get_image=bind('XGetImage',ptr,ptr,ul,c.c_int,c.c_int,ui,ui,ul,c.c_int)
get_pixel=bind('XGetPixel',ul,ptr,c.c_int,c.c_int);destroy=bind('XDestroyImage',c.c_int,ptr)
close_display=bind('XCloseDisplay',c.c_int,ptr)
d=open_display(None);assert d

def clients():
 # Use the window manager's application list. Walking its changing decoration
 # tree races destroyed helper windows and can capture the wrong drawable.
 return {int(value,16) for value in re.findall(r'0x[0-9a-fA-F]+',command(['xprop','-root','_NET_CLIENT_LIST']))}

def find_new(before):
 matches=[]
 for window in clients()-before:
  attr=Attributes()
  if attributes(d,window,c.byref(attr)) and (attr.width,attr.height,attr.depth)==(480,360,24) and attr.map_state==2 and not attr.override_redirect:matches.append(window)
 assert len(matches)<=1,('ambiguous render windows',matches)
 return matches[0] if matches else None

def frame(window):
 root=ul();xx=c.c_int();yy=c.c_int();w=ui();h=ui();border=ui();depth=ui()
 assert geometry(d,window,c.byref(root),c.byref(xx),c.byref(yy),c.byref(w),c.byref(h),c.byref(border),c.byref(depth))
 assert 100<=w.value<=1024 and 100<=h.value<=1024 and depth.value==24
 image=get_image(d,window,0,0,w,h,ul(-1).value,2);assert image
 try:
  pixels=[get_pixel(image,xx,yy)&0xffffff for yy in range(0,h.value,2) for xx in range(0,w.value,2)]
 finally:destroy(image)
 assert len(set(pixels))>=16
 return pixels

results=[]
try:
 for name,args in [('vkcube',['vkcube','--wsi','xlib','--width','480','--height','360']),('glxgears',['glxgears','-geometry','480x360+0+0'])]:
  before=clients()
  p=subprocess.Popen(args,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
  try:
   window=None;deadline=time.monotonic()+12
   while time.monotonic()<deadline:
    assert p.poll() is None,(name,p.stderr.read());window=find_new(before)
    if window:break
    time.sleep(.1)
   assert window,name
   time.sleep(1)
   maps=Path('/proc/'+str(p.pid)+'/maps').read_text();assert str(lib) in maps
   if name=='glxgears':assert str(gallium) in maps
   first=frame(window);time.sleep(.7);second=frame(window)
   changed=sum(a!=b for a,b in zip(first,second));assert len(first)==len(second) and changed>1000,(name,changed)
   digest=lambda pixels:hashlib.sha256(b''.join(x.to_bytes(4,'little') for x in pixels)).hexdigest()
   results.append({'program':name,'sampledPixels':len(first),'changedPixels':changed,'frameSha256':[digest(first),digest(second)],'driverMapped':True})
  finally:
   p.terminate()
   try:p.communicate(timeout=5)
   except subprocess.TimeoutExpired:p.kill();p.communicate()
finally:close_display(d)
print(json.dumps({'passed':True,'uid':os.getuid(),'capabilitiesZero':True,'seccomp':2,'noPhysicalGpu':True,'display':':0','rendering':'trusted CPU','maskedGpuOperations':0,'vulkanSummary':vk,'openGLSummary':gl,'frames':results}))
