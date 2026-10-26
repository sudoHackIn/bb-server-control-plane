#!/usr/bin/python3 -I
import argparse
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import hashlib
import stat


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--service-user', required=True)
    parser.add_argument('--users-root', required=True)
    parser.add_argument('--qwen-cli')
    parser.add_argument('--workflow-evaluator')
    parser.add_argument('--workspace-worker')
    parser.add_argument('--script-runtime', choices=['node-esm'])
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
    for name in ('runtime_policy.py', 'project_access.py', 'policy-preload.mjs'):
        source = pathlib.Path(__file__).with_name(name)
        target = helper.with_name(name)
        if source.resolve() != target.resolve():
            shutil.copyfile(source, target)
        os.chown(target, 0, 0)
        os.chmod(target, 0o644)
    settings = {'root': str(root), 'serviceUid': service.pw_uid}
    if args.qwen_cli or args.workflow_evaluator or args.workspace_worker or args.script_runtime:
        executables = [('node', args.node)] + ([('cli', args.qwen_cli)] if args.qwen_cli else [])
        for name, value in executables:
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
    if args.qwen_cli:
        cli_root = pathlib.Path(settings['cli']).parent
        digest = hashlib.sha256()
        for target in sorted(cli_root.rglob('*.js'), key=lambda path: path.relative_to(cli_root).as_posix()):
            current = target
            while current != cli_root:
                info = current.lstat()
                if current.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
                    raise ValueError('Qwen module paths must be root-owned and immutable to users')
                current = current.parent
            if not stat.S_ISREG(target.lstat().st_mode):
                raise ValueError('Qwen modules must be regular files')
            digest.update(target.relative_to(cli_root).as_posix().encode() + b'\0' + hashlib.sha256(target.read_bytes()).digest())
        if digest.hexdigest() != 'f722cb0a432c07047f16ddb3b480840dc77167795d508498180850d31bf9b7aa':
            raise ValueError('Unverified Qwen CLI artifact; review native policy and rerun deployment tests before approving this build')
    if args.workflow_evaluator:
        target = pathlib.Path(args.workflow_evaluator)
        if not target.is_absolute() or target.is_symlink() or not target.is_file():
            raise ValueError('Expected a regular workflow evaluator artifact')
        current = target
        while True:
            info = current.lstat()
            if current.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('Workflow evaluator must be root-owned and immutable')
            if current.parent == current:
                break
            current = current.parent
        settings['workflowEvaluator'] = str(target)
        settings['workflowEvaluatorSha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
    if args.workspace_worker:
        target = pathlib.Path(args.workspace_worker)
        if not target.is_absolute() or target.is_symlink() or not target.is_file():
            raise ValueError('Expected a regular workspace worker artifact')
        current = target
        while True:
            info = current.lstat()
            if current.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('Workspace worker must be root-owned and immutable')
            if current.parent == current:
                break
            current = current.parent
        settings['workspaceWorker'] = str(target)
        settings['workspaceWorkerSha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
    if args.script_runtime:
        settings['scriptRuntime'] = args.script_runtime
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
