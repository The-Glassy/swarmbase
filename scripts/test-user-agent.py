#!/usr/bin/python3 -I
"""Offline stand-in for both CLIs in the real-uid integration test."""
import errno
import json
import os
import signal
import subprocess
import sys
import time

req = json.loads(sys.stdin.read())
if req['action'] == 'hold':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    # Escape the process group and double-fork: the subreaper must still reap it.
    code = """import os, signal, time, json
os.setsid()
if os.fork(): os._exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open('escaped.pid', 'w') as f: f.write(str(os.getpid()))
while True: time.sleep(1)
"""
    subprocess.Popen(['/usr/bin/python3', '-I', '-c', code])
    with open('agent.pid', 'w') as f:
        f.write(str(os.getpid()))
    while True:
        time.sleep(1)

def denied(fn):
    try:
        fn()
        return None
    except OSError as e:
        return e.errno

def read_key():
    with open(req['otherKey']) as f:
        f.read()

def touch_other():
    with open(req['otherRoot'] + '/intrusion', 'w') as f:
        f.write('bad')

if req.get('write', True):
    with open('own.txt', 'w') as f:
        f.write('own-write-ok')
result = dict(uid=os.getuid(), keyError=denied(read_key), rootError=denied(touch_other),
              ownWrite=req.get('write', True), home=os.environ['HOME'], daemonSecret=os.environ.get('DAEMON_SECRET'),
              apiKey=os.environ.get('ANTHROPIC_API_KEY'))
result = {k: v for k, v in result.items() if v is not None}
result['directoryFds'] = []
import stat
for fd in os.listdir('/proc/self/fd'):
    try:
        if stat.S_ISDIR(os.fstat(int(fd)).st_mode):
            result['directoryFds'].append(int(fd))
    except OSError:
        pass
if os.environ.get('CODEX_HOME'):
    print(json.dumps(dict(type='item.completed', item=dict(type='agent_message', text=json.dumps(result)))))
    print(json.dumps(dict(type='turn.completed', usage=dict(input_tokens=0, output_tokens=0))))
else:
    print(json.dumps(dict(type='result', subtype='success', result=json.dumps(result), total_cost_usd=0)))
