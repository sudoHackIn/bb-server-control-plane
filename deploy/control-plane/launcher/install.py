#!/usr/bin/python3 -I
import argparse
import json
import os
import pathlib
import pwd
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--service-user', required=True)
    parser.add_argument('--users-root', required=True)
    parser.add_argument('--qwen-cli')
    parser.add_argument('--node', default='/usr/local/bin/node')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run this installer as root on the execution host')
    service = pwd.getpwnam(args.service_user)
    if service.pw_uid == 0 or 200000 <= service.pw_uid <= 299999 or not args.service_user.replace('-', '').replace('_', '').isalnum():
        raise ValueError('Expected a non-root service account')
    root = pathlib.Path(args.users_root)
    if not root.is_absolute() or str(root) == '/' or str(root) != os.path.normpath(root):
        raise ValueError('Expected an absolute non-root users directory')
    for path, mode in ((root, 0o711), (pathlib.Path('/etc/bb-agent-launcher'), 0o755), (pathlib.Path('/var/lib/bb-agent-launcher'), 0o700), (pathlib.Path('/var/lib/bb-agent-launcher/jobs'), 0o700), (pathlib.Path('/opt/bb-control-plane/launcher'), 0o755)):
        path.mkdir(parents=True, exist_ok=True, mode=mode)
        current = path
        while True:
            info = current.lstat()
            if current.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('Installer paths must be root-owned and not writable by other users')
            if current.parent == current:
                break
            current = current.parent
        os.chmod(path, mode)
    helper = pathlib.Path('/opt/bb-control-plane/launcher/helper.py')
    source = pathlib.Path(__file__).with_name('helper.py')
    if source.resolve() != helper.resolve():
        shutil.copyfile(source, helper)
    os.chown(helper, 0, 0)
    os.chmod(helper, 0o755)
    jobs = helper.with_name('jobs.py')
    source_jobs = pathlib.Path(__file__).with_name('jobs.py')
    if source_jobs.resolve() != jobs.resolve():
        shutil.copyfile(source_jobs, jobs)
    os.chown(jobs, 0, 0)
    os.chmod(jobs, 0o644)
    settings = {'root': str(root), 'serviceUid': service.pw_uid}
    if args.qwen_cli:
        for name, value in (('node', args.node), ('cli', args.qwen_cli)):
            target = pathlib.Path(value).resolve(strict=True)
            if not target.is_file():
                raise ValueError('Executable must be a regular file')
            current = target
            while True:
                info = current.lstat()
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise ValueError('Executable paths must be root-owned and immutable to users')
                if current.parent == current:
                    break
                current = current.parent
            settings[name] = str(target)
    policy = pathlib.Path('/etc/bb-agent-launcher/policy.json')
    policy.write_text(json.dumps(settings) + '\n')
    os.chown(policy, 0, 0)
    os.chmod(policy, 0o644)
    rule = pathlib.Path('/etc/sudoers.d/bb-agent-launcher')
    rule.write_text(f'Defaults!{helper} env_keep += "OPENAI_API_KEY OPENAI_BASE_URL"\n{args.service_user} ALL=(root) NOPASSWD: {helper}\n')
    os.chown(rule, 0, 0)
    os.chmod(rule, 0o440)
    subprocess.run(['/usr/sbin/visudo', '-cf', str(rule)], check=True)


if __name__ == '__main__':
    main()
