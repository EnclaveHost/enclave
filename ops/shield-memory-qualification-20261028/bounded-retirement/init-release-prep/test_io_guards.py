import os,signal,tempfile,unittest
import build_init as B
import compose_init_release as C
class NonRegularInputs(unittest.TestCase):
 def test_fifo_refused_without_waiting_for_writer(self):
  def timeout(*args):raise TimeoutError('reader blocked on FIFO')
  with tempfile.TemporaryDirectory() as d:
   p=os.path.join(d,'fifo');os.mkfifo(p)
   for label,call,error in [('init',lambda:B.read_regular(p,10),B.Refused),('composer',lambda:C._open_regular(p),C.Refused)]:
    with self.subTest(reader=label):
     old=signal.signal(signal.SIGALRM,timeout);signal.alarm(1)
     try:
      with self.assertRaises(error):call()
     finally:signal.alarm(0);signal.signal(signal.SIGALRM,old)
