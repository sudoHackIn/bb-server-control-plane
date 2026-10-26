import json
import os
import re
import runpy
import stat
import uuid

DIRECTORY = '/var/lib/bb-agent-launcher/uid-maintenance'
MAX_GENERATION = 9007199254740991
LEASES = runpy.run_path('/opt/bb-control-plane/launcher/uid_leases.py')


def read_record(directory, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError('Untrusted UID maintenance state')
        raw = os.read(fd, 65537)
        if len(raw) > 65536:
            raise ValueError('UID maintenance state too large')
        return json.loads(raw)
    finally:
        os.close(fd)


def write_record(directory, name, value):
    temporary = str(uuid.uuid4()) + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        raw = json.dumps(value, sort_keys=True).encode()
        with os.fdopen(fd, 'wb', closefd=False) as file:
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(fd)
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def state(directory, user_id, uid):
    value = read_record(directory, user_id + '.json')
    if value is None:
        return {'userId': user_id, 'uid': uid, 'generation': 0, 'blocked': False}
    if type(value) is not dict or set(value) != {'userId', 'uid', 'generation', 'blocked'} or value['userId'] != user_id or type(value['uid']) is not int or value['uid'] != uid or type(value['generation']) is not int or not 1 <= value['generation'] <= MAX_GENERATION or type(value['blocked']) is not bool:
        raise ValueError('Invalid UID maintenance binding')
    return value


def require_launch_allowed(user_id, uid, generation=0):
    directory = LEASES['trusted_directory'](DIRECTORY)
    try:
        current = state(directory, user_id, uid)
        if current['blocked'] or type(generation) is not int or generation != current['generation']:
            raise ValueError('UID maintenance is active or launch generation is stale')
    finally:
        os.close(directory)


def require_ready_policies(uid):
    path = '/var/lib/bb-agent-launcher/project-access'
    try:
        directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    try:
        info = os.fstat(directory)
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('Untrusted project policy directory')
        for name in os.listdir(directory):
            if not name.endswith('.json'):
                continue
            record = read_record(directory, name)
            if type(record) is not dict or record.get('phase') not in ('ready', 'pending'):
                raise ValueError('Invalid project policy')
            if record['phase'] != 'pending':
                continue
            writers = record.get('writers')
            if type(writers) is not list:
                raise ValueError('Legacy pending project writers require operator review')
            if record.get('ownerUid') == uid or any(writer['uid'] == uid for writer in writers):
                raise ValueError('UID project policy is pending')
    finally:
        os.close(directory)


def manage(user_id, uid, args):
    if os.geteuid() != 0 or not args or args[0] not in ('begin', 'finish', 'status'):
        raise ValueError('Invalid UID maintenance action')
    action = args[0]
    if action == 'status':
        if len(args) != 1:
            raise ValueError('Unexpected maintenance status arguments')
        generation = 0
    else:
        if len(args) != 2 or not re.fullmatch(r'[1-9][0-9]{0,15}', args[1]) or int(args[1]) > MAX_GENERATION:
            raise ValueError('Invalid UID maintenance generation')
        generation = int(args[1])
    directory = LEASES['trusted_directory'](DIRECTORY)
    try:
        current = state(directory, user_id, uid)
        if action == 'begin':
            if generation < current['generation'] or (generation == current['generation'] and not current['blocked']):
                raise ValueError('Stale UID maintenance generation')
            if generation > current['generation']:
                current = {'userId': user_id, 'uid': uid, 'generation': generation, 'blocked': True}
                write_record(directory, user_id + '.json', current)
        elif action == 'finish':
            if generation != current['generation']:
                raise ValueError('Stale UID maintenance completion')
            if current['blocked']:
                with LEASES['exclusive']([uid]):
                    require_ready_policies(uid)
                    current = {**current, 'blocked': False}
                    write_record(directory, user_id + '.json', current)
        if action != 'status':
            os.fsync(directory)
            parent = os.open('/var/lib/bb-agent-launcher', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        print(json.dumps(current))
    finally:
        os.close(directory)
