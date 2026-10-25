import ctypes
import hashlib
import stat
import json
import os
import signal
import subprocess
import time
import uuid
import runpy

JOBS = '/var/lib/bb-agent-launcher/jobs'


def process_info(pid):
    try:
        with open('/proc/' + str(pid) + '/stat', encoding='utf8') as file:
            fields = file.read().rsplit(')', 1)[1].split()
        return {'parent': int(fields[1]), 'start': fields[19], 'state': fields[0]}
    except (OSError, ValueError, IndexError):
        return None


def client_ancestors(service_uid):
    found = []
    current = os.getppid()
    visited = set()
    while current > 1 and current not in visited:
        visited.add(current)
        info = process_info(current)
        if not info:
            raise RuntimeError('Launcher ancestry changed before start')
        with open('/proc/' + str(current) + '/status', encoding='utf8') as file:
            line = next(line for line in file if line.startswith('Uid:'))
        real_uid, effective_uid = map(int, line.split()[1:3])
        if service_uid in (real_uid, effective_uid):
            found.append((current, info['start']))
        current = info['parent']
    if not found:
        raise RuntimeError('Launcher service ancestry is unavailable')
    return found


def clients_alive(clients):
    for pid, start in clients:
        info = process_info(pid)
        if not info or info['start'] != start or info['state'] == 'Z':
            return False
    return True


def descendants(root):
    processes = {}
    for name in os.listdir('/proc'):
        if name.isdecimal():
            info = process_info(int(name))
            if info:
                processes[int(name)] = info
    found = {root}
    while True:
        added = {pid for pid, info in processes.items() if info['parent'] in found} - found
        if not added:
            break
        found.update(added)
    return [(pid, processes[pid]) for pid in found if pid != root and pid in processes]


def cleanup(root):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        targets = descendants(root)
        for signum in (signal.SIGSTOP, signal.SIGKILL):
            for pid, info in targets:
                current = process_info(pid)
                if current and current['start'] == info['start']:
                    try:
                        os.kill(pid, signum)
                    except ProcessLookupError:
                        pass
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
            except ChildProcessError:
                break
        if not descendants(root):
            return
        time.sleep(0.01)
    raise RuntimeError('Agent descendants did not terminate')


def lease_path(session_id):
    if str(uuid.UUID(session_id)) != session_id:
        raise ValueError('Invalid Qwen session identity')
    return os.path.join(JOBS, session_id + '.json')


def stop_job(user_id, uid, session_id, lock):
    path = lease_path(session_id)
    try:
        with open(path, encoding='utf8') as file:
            lease = json.load(file)
    except FileNotFoundError:
        with open(path, 'w', encoding='utf8') as file:
            os.chmod(path, 0o600)
            json.dump({'userId': user_id, 'uid': uid, 'stopped': True}, file)
        os.close(lock)
        return
    if lease['userId'] != user_id or lease['uid'] != uid:
        raise ValueError('Job belongs to another identity')
    if lease.get('stopped'):
        os.close(lock)
        return
    current = process_info(lease['pid'])
    if not current or current['start'] != lease['start'] or current['state'] == 'Z':
        os.unlink(path)
        os.close(lock)
        return
    os.kill(lease['pid'], signal.SIGTERM)
    os.close(lock)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        current = process_info(lease['pid'])
        if not current or current['start'] != lease['start'] or current['state'] == 'Z':
            return
        time.sleep(0.02)
    raise RuntimeError('Job supervisor did not stop')


def launch_job(policy, user_id, uid, home, cwd, session_id, arguments, lock, launch_policy=None, runtime='qwen'):
    path = lease_path(session_id)
    entry = policy.get('workflowEvaluator') if runtime == 'workflow' else policy.get('cli')
    if runtime not in ('qwen', 'workflow') or not policy.get('node') or not entry:
        raise ValueError('Agent execution is not configured')
    if runtime == 'workflow':
        if arguments or launch_policy is not None:
            raise ValueError('Workflow evaluator arguments cannot be overridden')
        current = entry
        while True:
            info = os.lstat(current)
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('Untrusted workflow evaluator path')
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
        with open(entry, 'rb') as artifact:
            if hashlib.sha256(artifact.read()).hexdigest() != policy.get('workflowEvaluatorSha256'):
                raise ValueError('Workflow evaluator artifact changed')
    if os.path.exists(path):
        with open(path, encoding='utf8') as file:
            old = json.load(file)
        if old['userId'] != user_id or old['uid'] != uid or old.get('stopped'):
            raise ValueError('Job identity is unavailable')
        current = process_info(old['pid'])
        if current and current['start'] == old['start'] and current['state'] != 'Z':
            raise ValueError('Qwen session is already running')
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('Could not supervise agent descendants')
    pid = os.getpid()
    clients = client_ancestors(policy['serviceUid'])
    info = process_info(pid)
    if not info:
        raise RuntimeError('Could not identify supervisor')
    lease = {'userId': user_id, 'uid': uid, 'pid': pid, 'start': info['start']}
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf8') as file:
        os.chmod(temporary, 0o600)
        json.dump(lease, file)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    os.close(lock)
    child = None

    def interrupt(_signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': home,
           'USER': user_id, 'LOGNAME': user_id, 'PWD': cwd, 'BB_AGENT_JOB_ID': session_id}
    for name in (('OPENAI_API_KEY', 'OPENAI_BASE_URL') if runtime == 'qwen' else ()):
        if name in os.environ:
            env[name] = os.environ[name]
    os.umask(0o077)
    runtime_directory = None
    runtime_policy = runpy.run_path('/opt/bb-control-plane/launcher/runtime_policy.py') if launch_policy is not None else None
    try:
        preloads = []
        if runtime_policy is not None:
            runtime_directory = runtime_policy['create_policy'](home, uid, session_id, launch_policy)
            env['BB_AGENT_POLICY_PATH'] = os.path.join(runtime_directory, 'policy.json')
            env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = os.path.join(runtime_directory, 'settings.json')
            env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] = os.path.join(runtime_directory, 'settings.json')
            env['QWEN_CODE_NO_RELAUNCH'] = 'true'
            preloads = ['--import', '/opt/bb-control-plane/launcher/policy-preload.mjs']
        child = subprocess.Popen(['/usr/bin/setpriv', '--reuid=' + str(uid), '--regid=' + str(uid),
                                  '--clear-groups', '--no-new-privs', '--', '/usr/bin/unshare',
                                  '--user', '--map-user=' + str(uid), '--map-group=' + str(uid),
                                  '--pid', '--fork', '--mount-proc', policy['node'],
                                  '--dns-result-order=ipv4first', *preloads, *(['--max-old-space-size=128'] if runtime == 'workflow' else []), entry, *arguments],
                                 env=env, close_fds=True, start_new_session=True)
        while clients_alive(clients):
            try:
                return child.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
        return 125
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        cleanup(pid)
        if runtime_directory is not None:
            runtime_policy['remove_policy'](runtime_directory)
        try:
            with open(path, encoding='utf8') as file:
                current_lease = json.load(file)
            if current_lease == lease:
                os.unlink(path)
        except FileNotFoundError:
            pass
