import ctypes
import hashlib
import json
import os
import re
import runpy
import stat
import pwd
import grp
import sys
import time
import uuid


STATE = '/var/lib/bb-agent-launcher/project-access'
MAX_ENTRIES = 100000


LIBACL = ctypes.CDLL('libacl.so.1', use_errno=True)
LIBACL.acl_from_text.argtypes = [ctypes.c_char_p]
LIBACL.acl_from_text.restype = ctypes.c_void_p
LIBACL.acl_set_fd.argtypes = [ctypes.c_int, ctypes.c_void_p]
LIBACL.acl_set_fd.restype = ctypes.c_int
LIBACL.acl_set_file.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
LIBACL.acl_set_file.restype = ctypes.c_int
LIBACL.acl_free.argtypes = [ctypes.c_void_p]
LIBACL.acl_free.restype = ctypes.c_int


def set_acl(fd, entries, default=False):
    acl = LIBACL.acl_from_text(','.join(entries).encode())
    if not acl:
        raise ValueError('Invalid ACL')
    try:
        result = LIBACL.acl_set_file(('/proc/self/fd/' + str(fd)).encode(), 0x4000, acl) if default else LIBACL.acl_set_fd(fd, acl)
        if result != 0:
            raise OSError(ctypes.get_errno(), 'Project ACL update failed')
    finally:
        LIBACL.acl_free(acl)


def read_json(directory, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError('Untrusted access state')
        raw = os.read(fd, 65537)
        if len(raw) > 65536:
            raise ValueError('Access state too large')
        return json.loads(raw)
    finally:
        os.close(fd)


def write_json(directory, name, value):
    temporary = str(uuid.uuid4()) + '.tmp'
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        raw = json.dumps(value, sort_keys=True).encode()
        if len(raw) > 65536:
            raise ValueError('Access state too large')
        with os.fdopen(fd, 'wb', closefd=False) as file:
            file.write(raw)
            file.flush()
            os.fsync(fd)
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(fd)
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def checked_identity(value, registry):
    if type(value) is not dict or set(value) != {'userId', 'uid'}:
        raise ValueError('Invalid project member')
    user_id, uid = value['userId'], value['uid']
    if type(user_id) is not str or str(uuid.UUID(user_id)) != user_id or type(uid) is not int or not 200000 <= uid <= 299999:
        raise ValueError('Invalid project identity')
    for lookup in (pwd.getpwuid, grp.getgrgid):
        try:
            lookup(uid)
        except KeyError:
            pass
        else:
            raise ValueError('Project identity collides with a system account')
    expected = {'userId': user_id, 'uid': uid, 'gid': uid}
    if read_json(registry, user_id + '.json') != expected:
        raise ValueError('Unregistered project identity')
    return {'userId': user_id, 'uid': uid}


def permission(bits):
    return ''.join(letter if bits & mask else '-' for letter, mask in [('r', 4), ('w', 2), ('x', 1)])


def apply_acl(fd, info, owner_uid, service_uid, members, deadline, directory=False, root_members=None):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError('Project ACL deadline exceeded')
    execute = directory or bool(info.st_mode & 0o111)
    access = 'rwx' if execute else 'rw-'
    owner = permission((info.st_mode >> 6) & 7)
    selected = members if root_members is None else root_members
    names = sorted({owner_uid, service_uid, *[item['uid'] for item in selected]})
    acl = ['u::' + ('rwx' if root_members is not None else owner), 'g::---', 'o::---', 'm::' + access]
    acl.extend('u:' + str(uid) + ':' + access for uid in names)
    set_acl(fd, acl)
    if directory:
        defaults = ['u::rwx', 'g::---', 'o::---', 'm::rwx']
        defaults.extend('u:' + str(uid) + ':rwx' for uid in sorted({owner_uid, service_uid, *[item['uid'] for item in members]}))
        set_acl(fd, defaults, default=True)



def synchronize(policy, root_fd, owner_id, owner_uid, args):
    if os.geteuid() != 0:
        raise ValueError('Project ACL requires root')
    if len(args) != 3:
        raise ValueError('Expected project slug, ID and revision')
    slug, project_id, raw_revision = args
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', slug) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,199}', project_id) or not re.fullmatch(r'[1-9][0-9]{0,15}', raw_revision):
        raise ValueError('Invalid project binding')
    revision = int(raw_revision)
    if revision > 9007199254740991:
        raise ValueError('Invalid revision')
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('Project members too large')
    request = json.loads(raw)
    if type(request) is not dict or set(request) != {'members'} or type(request['members']) is not list or len(request['members']) > 128:
        raise ValueError('Invalid project members')
    registry = os.open('/var/lib/bb-agent-launcher', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    members = [checked_identity(value, registry) for value in request['members']]
    os.close(registry)
    if len({item['uid'] for item in members}) != len(members) or len({item['userId'] for item in members}) != len(members) or any(item['userId'] == owner_id or item['uid'] == owner_uid for item in members):
        raise ValueError('Duplicate project identity')
    members.sort(key=lambda item: item['userId'])
    try:
        os.mkdir(STATE, 0o700)
    except FileExistsError:
        pass
    state_fd = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    state_info = os.fstat(state_fd)
    if state_info.st_uid != 0 or stat.S_IMODE(state_info.st_mode) != 0o700:
        raise ValueError('Untrusted project state directory')
    digest = hashlib.sha256(project_id.encode()).hexdigest()
    filename = owner_id + '-' + digest + '.json'
    binding = {'version': 1, 'projectId': project_id, 'ownerId': owner_id, 'ownerUid': owner_uid, 'slug': slug}
    old = None
    records = []
    for name in os.listdir(state_fd):
        if not name.endswith('.json'):
            continue
        record = read_json(state_fd, name)
        if type(record) is not dict:
            raise ValueError('Invalid project state')
        if record.get('projectId') == project_id:
            if name != filename or any(record.get(key) != value for key, value in binding.items()):
                raise ValueError('Project binding cannot be reassigned')
            old = record
        elif record.get('ownerId') == owner_id and record.get('slug') == slug:
            raise ValueError('Project folder is already registered')
        if record.get('ownerId') == owner_id:
            records.append(record)
    if old and (old['revision'] > revision or (old['revision'] == revision and old['members'] != members)):
        raise ValueError('Stale or conflicting project revision')
    if old and old.get('phase') == 'pending' and 'writers' not in old:
        raise ValueError('Legacy pending project writers require operator review')
    writers = old.get('writers', old['members']) if old else []
    registry = os.open('/var/lib/bb-agent-launcher', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    legacy_uids = []
    try:
        writers = [checked_identity(value, registry) for value in writers]
        if old and 'writers' not in old:
            for name in os.listdir(registry):
                if name.endswith('.json'):
                    identity = read_json(registry, name)
                    legacy_uids.append(checked_identity({'userId': identity['userId'], 'uid': identity['uid']}, registry)['uid'])
    finally:
        os.close(registry)
    writers = sorted({item['userId']: item for item in [*writers, *members]}.values(), key=lambda item: item['userId'])
    leases = runpy.run_path('/opt/bb-control-plane/launcher/uid_leases.py')
    if legacy_uids:
        leases['require_idle'](legacy_uids)
    with leases['exclusive']([owner_uid, *[item['uid'] for item in writers]]):
        base_fd = os.open(owner_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        if os.fstat(base_fd).st_uid != 0 or stat.S_IMODE(os.fstat(base_fd).st_mode) != 0o711:
            raise ValueError('Untrusted user root')
        projects_fd = os.open('projects', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base_fd)
        os.close(base_fd)
        projects_info = os.fstat(projects_fd)
        if projects_info.st_uid != owner_uid or projects_info.st_gid != owner_uid or stat.S_IMODE(projects_info.st_mode) != 0o710:
            raise ValueError('Untrusted projects root')
        project_fd = os.open(slug, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=projects_fd)
        info = os.fstat(project_fd)
        if info.st_uid != owner_uid or info.st_gid != owner_uid or stat.S_IMODE(info.st_mode) != 0o770:
            raise ValueError('Untrusted project directory')
        previous = old.get('activeMembers', old['members'] if old.get('phase') == 'ready' else []) if old else []
        retained = [item for item in previous if item in members]
        record = {**binding, 'revision': revision, 'members': members, 'activeMembers': retained, 'writers': writers, 'phase': 'pending'}
        write_json(state_fd, filename, record)
        deadline = time.monotonic() + 20

        def parent_acl(active):
            allowed = set()
            for item in records:
                if item.get('projectId') != project_id:
                    allowed.update(member['uid'] for member in item.get('activeMembers', item['members'] if item.get('phase') == 'ready' else []))
            allowed.update(member['uid'] for member in active)
            acl = ['u::rwx', 'g::---', 'o::---', 'm::--x', 'u:' + str(policy['serviceUid']) + ':--x']
            acl.extend('u:' + str(uid) + ':--x' for uid in sorted(allowed))
            set_acl(projects_fd, acl)

        count = 0
        visited = set()

        def walk(fd, depth):
            nonlocal count
            current = os.fstat(fd)
            if depth > 128 or current.st_dev != info.st_dev or (current.st_dev, current.st_ino) in visited:
                raise ValueError('Invalid project tree')
            visited.add((current.st_dev, current.st_ino))
            apply_acl(fd, current, owner_uid, policy['serviceUid'], members, deadline, directory=True, root_members=retained if depth == 0 else None)
            for name in os.listdir(fd):
                count += 1
                if count > MAX_ENTRIES or time.monotonic() >= deadline:
                    raise ValueError('Project tree exceeds limits')
                if stat.S_ISLNK(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
                    continue
                child = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    entry = os.fstat(child)
                    if entry.st_uid != policy['serviceUid'] and not 200000 <= entry.st_uid <= 299999:
                        raise ValueError('Untrusted project entry owner')
                    if entry.st_dev != info.st_dev or entry.st_mode & 0o7000:
                        raise ValueError('Untrusted project entry')
                    if stat.S_ISDIR(entry.st_mode):
                        walk(child, depth + 1)
                    elif stat.S_ISREG(entry.st_mode) and entry.st_nlink == 1:
                        apply_acl(child, entry, owner_uid, policy['serviceUid'], members, deadline)
                    else:
                        raise ValueError('Unsupported project entry')
                finally:
                    os.close(child)

        try:
            apply_acl(project_fd, info, owner_uid, policy['serviceUid'], members, deadline, directory=True, root_members=retained)
            parent_acl(retained)
            walk(project_fd, 0)
            current = os.stat(slug, dir_fd=projects_fd, follow_symlinks=False)
            if current.st_dev != info.st_dev or current.st_ino != info.st_ino:
                raise ValueError('Project directory moved during synchronization')
            apply_acl(project_fd, info, owner_uid, policy['serviceUid'], members, deadline, directory=True)
            parent_acl(members)
            write_json(state_fd, filename, {**record, 'activeMembers': members, 'writers': members, 'phase': 'ready'})
            print(json.dumps({'projectId': project_id, 'revision': revision, 'cwd': os.path.join(policy['root'], owner_id, 'projects', slug), 'memberCount': len(members), 'state': 'ready'}))
        except BaseException:
            apply_acl(project_fd, info, owner_uid, policy['serviceUid'], retained, time.monotonic() + 2, directory=True, root_members=retained)
            parent_acl(retained)
            raise
        finally:
            os.close(project_fd)
            os.close(projects_fd)
            os.close(state_fd)



def describe(policy, root_fd, owner_id, owner_uid, args):
    if len(args) != 2:
        raise ValueError('Expected project slug and ID')
    slug, project_id = args
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', slug) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,199}', project_id):
        raise ValueError('Invalid project binding')
    directory = runpy.run_path('/opt/bb-control-plane/launcher/uid_leases.py')['trusted_directory'](STATE)
    try:
        name = owner_id + '-' + hashlib.sha256(project_id.encode()).hexdigest() + '.json'
        record = read_json(directory, name)
        if record is None:
            revision, phase, writers, legacy = 0, 'absent', [], False
        else:
            if type(record) is not dict or record.get('version') != 1 or record.get('projectId') != project_id or record.get('ownerId') != owner_id or record.get('ownerUid') != owner_uid or record.get('slug') != slug or record.get('phase') not in ('ready', 'pending'):
                raise ValueError('Project binding changed')
            legacy = 'writers' not in record
            if legacy and record['phase'] == 'pending':
                raise ValueError('Legacy pending project writers require operator review')
            registry = os.open('/var/lib/bb-agent-launcher', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                writers = [checked_identity(item, registry) for item in record.get('writers', record['members'])]
            finally:
                os.close(registry)
            revision, phase = record['revision'], record['phase']
        print(json.dumps({'projectId': project_id, 'cwd': os.path.join(policy['root'], owner_id, 'projects', slug), 'revision': revision, 'phase': phase, 'writers': writers, 'requiresGlobalIdle': legacy}))
    finally:
        os.close(directory)
