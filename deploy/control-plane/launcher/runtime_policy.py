import json
import os
import re
import stat
import subprocess


def read_exact(size):
    chunks = []
    while size:
        chunk = os.read(0, min(size, 65536))
        if not chunk:
            raise ValueError('Incomplete launcher bootstrap')
        chunks.append(chunk)
        size -= len(chunk)
    return b''.join(chunks)


def read_policy():
    header = b''
    while not header.endswith(b'\n'):
        if len(header) >= 40:
            raise ValueError('Invalid bootstrap header')
        header += read_exact(1)
    if not re.fullmatch(rb'BB_AGENT_POLICY [1-9][0-9]{0,6}\n', header):
        raise ValueError('Invalid bootstrap header')
    size = int(header.split()[1])
    if size > 1048576:
        raise ValueError('Agent policy is too large')
    value = json.loads(read_exact(size))
    if not isinstance(value, dict) or set(value) != {'arguments', 'appendPrompt', 'settings'}:
        raise ValueError('Invalid agent policy')
    arguments = value['arguments']
    if not isinstance(arguments, list) or len(arguments) > 128 or any(not isinstance(item, str) or '\0' in item for item in arguments):
        raise ValueError('Invalid policy arguments')
    if not isinstance(value['appendPrompt'], str) or not isinstance(value['settings'], dict):
        raise ValueError('Invalid policy settings')
    return value


def create_policy(home, uid, job_id, value):
    root = os.path.join(os.path.dirname(home), 'runtime')
    info = os.lstat(root)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o711:
        raise ValueError('Invalid runtime policy directory')
    directory = os.path.join(root, job_id)
    os.mkdir(directory, 0o700)
    try:
        for name, content in (('settings.json', value['settings']), ('policy.json', {'arguments': value['arguments'], 'appendPrompt': value['appendPrompt']})):
            path = os.path.join(directory, name)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
            with os.fdopen(fd, 'w', encoding='utf8') as file:
                json.dump(content, file)
            subprocess.run(['/usr/bin/setfacl', '-m', 'u:' + str(uid) + ':r--', path], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['/usr/bin/setfacl', '-m', 'u:' + str(uid) + ':r-x', directory], check=True, stdout=subprocess.DEVNULL)
        return directory
    except BaseException:
        remove_policy(directory)
        raise


def remove_policy(directory):
    for name in ('settings.json', 'policy.json'):
        try:
            os.unlink(os.path.join(directory, name))
        except FileNotFoundError:
            pass
    os.rmdir(directory)
