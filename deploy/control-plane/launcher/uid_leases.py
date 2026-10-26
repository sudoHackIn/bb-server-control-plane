import contextlib
import fcntl
import json
import os
import stat
import uuid

DIRECTORY = '/var/lib/bb-agent-launcher/uid-leases'
JOBS = '/var/lib/bb-agent-launcher/jobs'


def trusted_directory(path):
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise ValueError('Untrusted UID lease directory')
    return fd


def acquire(uids, exclusive=False):
    if os.geteuid() != 0 or not uids or any(type(uid) is not int or not 200000 <= uid <= 299999 for uid in uids):
        raise ValueError('Invalid UID lease identity')
    directory = trusted_directory(DIRECTORY)
    acquired = []
    try:
        for uid in sorted(set(uids)):
            fd = os.open(str(uid), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            acquired.append(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
                raise ValueError('Untrusted UID lease')
            try:
                fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('UID execution is busy') from None
        return acquired
    except BaseException:
        for fd in acquired:
            os.close(fd)
        raise
    finally:
        os.close(directory)


def require_idle(uids):
    selected = set(uids)
    directory = trusted_directory(JOBS)
    try:
        for name in os.listdir(directory):
            if not name.endswith('.json'):
                continue
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                continue
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
                    raise ValueError('Untrusted job lease')
                raw = os.read(fd, 65537)
                if len(raw) > 65536:
                    raise ValueError('Invalid job lease')
                lease = json.loads(raw)
                if type(lease) is not dict or type(lease.get('uid')) is not int or not 200000 <= lease['uid'] <= 299999 or type(lease.get('userId')) is not str or str(uuid.UUID(lease['userId'])) != lease['userId']:
                    raise ValueError('Invalid job lease')
                if 'stopped' in lease and (lease['stopped'] is not True or set(lease) != {'userId', 'uid', 'stopped'}):
                    raise ValueError('Invalid stopped job lease')
                if lease['uid'] in selected and lease.get('stopped') is not True:
                    raise ValueError('UID job cleanup is unconfirmed')
            finally:
                os.close(fd)
    finally:
        os.close(directory)
    for name in os.listdir('/proc'):
        if not name.isdecimal():
            continue
        try:
            with open('/proc/' + name + '/status', encoding='utf8') as file:
                fields = next(line for line in file if line.startswith('Uid:')).split()[1:]
            if not selected.intersection(map(int, fields)):
                continue
            with open('/proc/' + name + '/stat', encoding='utf8') as file:
                state = file.read().rsplit(')', 1)[1].split()[0]
            if state != 'Z':
                raise ValueError('Unmanaged UID execution is busy')
        except (FileNotFoundError, ProcessLookupError):
            pass


@contextlib.contextmanager
def exclusive(uids):
    acquired = acquire(uids, exclusive=True)
    try:
        require_idle(uids)
        yield
    finally:
        for fd in acquired:
            os.close(fd)
