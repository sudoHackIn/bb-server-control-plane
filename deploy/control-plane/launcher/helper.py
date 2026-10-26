#!/usr/bin/python3 -I
import fcntl
import json
import os
import re
import pwd
import grp
import stat
import subprocess
import sys
import uuid
import runpy

POLICY = '/etc/bb-agent-launcher/policy.json'


def trusted_file(path):
    current = path
    while True:
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted policy/helper path')
        parent = os.path.dirname(current)
        if parent == current:
            return
        current = parent


def directory(parent, name, uid, gid, mode):
    created = False
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        created = True
    except FileExistsError:
        pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if created or (uid != 0 and info.st_uid == 0):
            if info.st_uid != 0:
                raise ValueError('Directory replaced during creation')
            os.fchown(fd, uid, gid)
            os.fchmod(fd, mode)
        elif info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:

            raise ValueError('Existing directory ownership or mode mismatch')
        return fd
    except BaseException:
        os.close(fd)
        raise


def main():
    if os.geteuid() != 0:
        raise ValueError('Helper requires root')
    trusted_file(POLICY)
    with open(POLICY, encoding='utf8') as file:
        policy = json.load(file)
    operation, user_id, raw_uid, *args = sys.argv[1:]
    if operation not in ('provision', 'project', 'project-access', 'project-access-status', 'uid-maintenance', 'launch', 'launch-policy', 'launch-workflow', 'launch-script', 'launch-workspace', 'stop'):
        raise ValueError('Invalid launcher operation')
    if str(uuid.UUID(user_id)) != user_id or not re.fullmatch(r'[0-9]{6}', raw_uid):
        raise ValueError('Invalid identity')
    uid = int(raw_uid)
    if not 200000 <= uid <= 299999:
        raise ValueError('UID outside reserved range')
    for lookup in (pwd.getpwuid, grp.getgrgid):
        try:
            lookup(uid)
        except KeyError:
            pass
        else:
            raise ValueError('Reserved UID/GID collides with a system identity')
    if policy['serviceUid'] == uid:
        raise ValueError('Service UID cannot be used for Qwen')
    root = policy['root']
    trusted_file(root)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    lock = os.open('/var/lib/bb-agent-launcher/lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    manifest = '/var/lib/bb-agent-launcher/' + user_id + '.json'
    identity = {'userId': user_id, 'uid': uid, 'gid': uid}
    if os.path.exists(manifest):
        with open(manifest, encoding='utf8') as file:
            if json.load(file) != identity:
                raise ValueError('Identity cannot be reassigned')
    elif operation == 'provision':

        for entry in os.scandir('/var/lib/bb-agent-launcher'):
            if entry.name.endswith('.json'):
                with open(entry.path, encoding='utf8') as file:
                    if json.load(file)['uid'] == uid:
                        raise ValueError('UID is already provisioned')
        temporary = manifest + '.tmp'
        with open(temporary, 'w', encoding='utf8') as file:
            os.chmod(temporary, 0o600)
            json.dump(identity, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, manifest)
        manifest_dir = os.open('/var/lib/bb-agent-launcher', os.O_DIRECTORY | os.O_RDONLY)
        os.fsync(manifest_dir)
        os.close(manifest_dir)
    else:
        raise ValueError('Identity is not provisioned')
    if operation == 'uid-maintenance':
        maintenance_file = '/opt/bb-control-plane/launcher/uid_maintenance.py'
        trusted_file(maintenance_file)
        return runpy.run_path(maintenance_file)['manage'](user_id, uid, args)
    if operation in ('project-access', 'project-access-status'):
        access_file = '/opt/bb-control-plane/launcher/project_access.py'
        trusted_file(access_file)
        return runpy.run_path(access_file)['describe' if operation == 'project-access-status' else 'synchronize'](policy, root_fd, user_id, uid, args)
    base = os.path.join(root, user_id)
    home = os.path.join(base, 'home')
    projects = os.path.join(base, 'projects')
    if operation in ('launch', 'launch-policy', 'launch-workflow', 'launch-script', 'launch-workspace', 'stop'):
        jobs_directory = '/var/lib/bb-agent-launcher/jobs'
        try:
            os.mkdir(jobs_directory, 0o700)
        except FileExistsError:
            pass
        jobs_info = os.lstat(jobs_directory)
        if not stat.S_ISDIR(jobs_info.st_mode) or jobs_info.st_uid != 0 or stat.S_IMODE(jobs_info.st_mode) != 0o700:
            raise ValueError('Invalid job state directory')
        jobs_file = '/opt/bb-control-plane/launcher/jobs.py'
        trusted_file(jobs_file)
        jobs = runpy.run_path(jobs_file)
        if operation == 'stop' and len(args) == 1:
            return jobs['stop_job'](user_id, uid, args[0], lock)
        maintenance_generation = 0
        if operation != 'stop' and args and args[0].startswith('--uid-generation='):
            raw_generation = args.pop(0).removeprefix('--uid-generation=')
            if not re.fullmatch(r'0|[1-9][0-9]{0,15}', raw_generation) or int(raw_generation) > 9007199254740991:
                raise ValueError('Invalid launch generation')
            maintenance_generation = int(raw_generation)
        launch_policy = None
        if operation in ('launch-workflow', 'launch-script', 'launch-workspace') and len(args) == 2:
            args = [*args, '--']
        if operation == 'launch-policy' and len(args) == 2:
            policy_file = '/opt/bb-control-plane/launcher/runtime_policy.py'
            trusted_file(policy_file)
            launch_policy = runpy.run_path(policy_file)['read_policy']()
            args = [*args, '--']
        if operation not in ('launch', 'launch-policy', 'launch-workflow', 'launch-script', 'launch-workspace') or len(args) < 3 or args[2] != '--':
            raise ValueError('Expected session, cwd and CLI arguments')
        session_id, cwd, _, *cli_args = args
        if len(cli_args) > 128 or sum(map(len, cli_args)) > 131072:
            raise ValueError('Too many CLI arguments')
        if not os.path.isabs(cwd) or os.path.normpath(cwd) != cwd:
            raise ValueError('Invalid workspace path')
        relative = os.path.relpath(cwd, root)
        parts = relative.split(os.sep)
        if len(parts) < 3 or not re.fullmatch(r'[0-9a-f-]{36}', parts[0]) or parts[1] != 'projects' or any(part in ('', '.', '..') for part in parts):
            raise ValueError('Workspace must be below a registered projectsRoot')
        owner_id, _, slug, *subdirs = parts
        if str(uuid.UUID(owner_id)) != owner_id or not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', slug):
            raise ValueError('Invalid project workspace')
        base_fd = os.open(user_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        home_fd = os.open('home', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base_fd)
        info = os.fstat(home_fd)
        if info.st_uid != uid or info.st_gid != uid or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('Invalid HOME ownership or mode')
        os.close(home_fd)
        if launch_policy is not None:
            runtime_fd = directory(base_fd, 'runtime', 0, 0, 0o711)
            os.close(runtime_fd)
        os.close(base_fd)
        owner_fd = os.open(owner_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        fd = os.open('projects', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=owner_fd)
        os.close(owner_fd)
        for part in [slug, *subdirs]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            if part == slug:
                project_owner_uid = os.fstat(fd).st_uid
        if owner_id == user_id:
            if os.fstat(fd).st_uid != uid:
                raise ValueError('Project belongs to another identity')
        else:
            access_file = '/opt/bb-control-plane/launcher/project_access.py'
            trusted_file(access_file)
            access = runpy.run_path(access_file)
            state = access['STATE']
            state_fd = access['read_json']
            directory_fd = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                info = os.fstat(directory_fd)
                if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
                    raise ValueError('Untrusted project access state')
                matches = [state_fd(directory_fd, name) for name in os.listdir(directory_fd) if name.endswith('.json')]
            finally:
                os.close(directory_fd)
            matches = [record for record in matches if isinstance(record, dict) and record.get('ownerId') == owner_id and record.get('slug') == slug]
            if len(matches) != 1 or matches[0].get('phase') != 'ready' or {'userId': user_id, 'uid': uid} not in matches[0].get('activeMembers', []):
                raise ValueError('Project access is not active for this identity')
            registry_fd = os.open('/var/lib/bb-agent-launcher', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                owner = access['read_json'](registry_fd, owner_id + '.json')
            finally:
                os.close(registry_fd)
            if owner != {'userId': owner_id, 'uid': matches[0].get('ownerUid'), 'gid': matches[0].get('ownerUid')} or project_owner_uid != owner['uid']:
                raise ValueError('Project owner binding changed')
        os.fchdir(fd)
        return jobs['launch_job'](policy, user_id, uid, home, cwd, session_id, cli_args, lock, launch_policy, {'launch-workflow': 'workflow', 'launch-script': 'script', 'launch-workspace': 'workspace'}.get(operation, 'qwen'), maintenance_generation)
    if operation == 'provision' and not args:

        base_fd = directory(root_fd, user_id, 0, 0, 0o711)
        home_fd = directory(base_fd, 'home', uid, uid, 0o700)
        projects_fd = directory(base_fd, 'projects', uid, uid, 0o710)
        os.close(home_fd)

        subprocess.run(['/usr/bin/setfacl', '-m', 'u:' + str(policy['serviceUid']) + ':--x', '/proc/self/fd/' + str(projects_fd)], pass_fds=(projects_fd,), check=True, stdout=subprocess.DEVNULL)

        project_fd = directory(projects_fd, 'default', uid, uid, 0o770)
        cwd = os.path.join(projects, 'default')
        subprocess.run(['/usr/bin/setfacl', '-m', 'u:' + str(policy['serviceUid']) + ':rwx,d:u:' + str(uid) + ':rwx,d:u:' + str(policy['serviceUid']) + ':rwx,d:m::rwx', '/proc/self/fd/' + str(project_fd)], pass_fds=(project_fd,), check=True, stdout=subprocess.DEVNULL)
        os.close(project_fd)
        print(json.dumps({**identity, 'home': home, 'projectsRoot': projects, 'cwd': cwd}))
        return
    if operation == 'project' and len(args) == 1:
        slug = args[0]
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', slug):
            raise ValueError('Invalid project slug')
        base_fd = os.open(user_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        projects_fd = os.open('projects', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base_fd)
        if os.fstat(projects_fd).st_uid != uid:
            raise ValueError('Invalid projects owner')
        project_fd = directory(projects_fd, slug, uid, uid, 0o770)
        subprocess.run(['/usr/bin/setfacl', '-m', 'u:' + str(policy['serviceUid']) + ':rwx,d:u:' + str(uid) + ':rwx,d:u:' + str(policy['serviceUid']) + ':rwx,d:m::rwx', '/proc/self/fd/' + str(project_fd)], pass_fds=(project_fd,), check=True, stdout=subprocess.DEVNULL)
        os.close(project_fd)
        print(json.dumps({'cwd': os.path.join(projects, slug)}))
        return
    raise ValueError('Invalid provisioning operation')


if __name__ == '__main__':
    try:
        sys.exit(main() or 0)
    except Exception:

        print('Agent launcher rejected the request', file=sys.stderr)
        sys.exit(1)
