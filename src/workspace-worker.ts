/** Sent over an authenticated SSH exec channel. Inputs travel on stdin, never in argv. */
export const WORKSPACE_WORKER = String.raw`
import os, sys, json, stat, hashlib, tempfile, subprocess, signal, shutil, fcntl
MAX_FILE = 4 * 1024 * 1024
def fail(message):
    raise ValueError(message)
def path_of(path, cwd):
    if not isinstance(path, str) or not path.strip() or '\0' in path:
        fail('A non-empty path is required')
    return os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))
def version(path):
    try:
        s = os.stat(path)
        return '%s:%s:%s:%s:%s' % (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    except FileNotFoundError:
        return None
def read_text(path):
    if not stat.S_ISREG(os.stat(path).st_mode): fail('Not a regular file')
    with open(path, 'rb') as f: data = f.read(MAX_FILE + 1)
    if len(data) > MAX_FILE: fail('File exceeds 4 MiB; use bash for a bounded read')
    if b'\0' in data: fail('Not a UTF-8 text file')
    return data.decode('utf-8')
def main(p):
    cwd = path_of(p['cwd'], os.path.expanduser('~'))
    if not os.path.isdir(cwd): fail('Remote workspace directory does not exist')
    op, a = p['op'], p.get('args', {})
    if op == 'probe':
        if shutil.which('bash') is None: fail('Remote host requires bash')
        return {'path': cwd}
    if op == 'bash':
        if a.get('run_in_background'): fail('Background jobs are not supported in SSH workspaces; use a foreground command')
        wd = path_of(a.get('workdir', cwd), cwd)
        timeout = a.get('timeoutMs', 60000)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 3600000:
            fail('timeoutMs must be between 1 and 3600000')
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(['bash', '-lc', a['command']], cwd=wd, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
            def stop(*_):
                try: os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda *_: (stop(), sys.exit(128)))
            timed_out = False
            try: proc.wait(timeout=timeout / 1000)
            except subprocess.TimeoutExpired:
                timed_out = True
                stop()
                proc.wait()
            def capture(f):
                f.seek(0)
                data = f.read(262145)
                return {'text': data[:262144].decode('utf-8', errors='replace'), 'truncated': len(data) > 262144}
            return {'value': {'kind': 'foreground', 'exitCode': proc.returncode if proc.returncode >= 0 else None,
                'signal': None if proc.returncode >= 0 else 'SIG' + str(-proc.returncode), 'timedOut': timed_out,
                'aborted': False, 'timeoutMs': timeout, 'stdout': capture(out), 'stderr': capture(err)}}
    path = path_of(a['file_path'], cwd)
    if op == 'resolve': return {'path': path}
    if p.get('expectedPath') is not None and path != p['expectedPath']:
        fail('FS_STALE_VERSION: path target changed; resolve and read it again')
    if op == 'read':
        observed = version(path)
        text = read_text(path)
        if version(path) != observed: fail('File changed during read; read it again')
        lines = text.splitlines()
        offset, limit = a.get('offset', 1), a.get('limit', 2000)
        if isinstance(offset, bool) or isinstance(limit, bool) or int(offset) != offset or int(limit) != limit or offset < 1 or limit < 1:
            fail('offset and limit must be positive integers')
        offset, limit = int(offset), min(int(limit), 2000)
        selected, used = [], 0
        for i in range(offset - 1, min(len(lines), offset - 1 + limit)):
            line = lines[i][:2000]
            used += len(line.encode('utf-8'))
            if used > 65536: break
            selected.append({'number': i + 1, 'text': line})
        return {'path': path, 'version': observed, 'value': {'path': path, 'offset': offset, 'lines': selected, 'totalLines': len(lines)}}
    if op not in ('write', 'edit'): fail('Unsupported SSH workspace operation')
    # Serialize this adapter's guarded writes across concurrent SSH channels.
    lock_dir = os.path.join(os.path.expanduser('~'), '.cache', 'dsh-ssh-ops-locks')
    os.makedirs(lock_dir, mode=0o700, exist_ok=True)
    lock_path = os.path.join(lock_dir, hashlib.sha256(path.encode()).hexdigest())
    with open(lock_path, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = version(path)
        guard = p.get('intent')
        if guard:
            if guard.get('kind') == 'createIfAbsent' and current is not None: fail('FS_NOT_OBSERVED: file already exists; read it first')
            if 'version' in guard and current != guard['version']: fail('FS_STALE_VERSION: file changed; read it again')
        before = read_text(path) if current is not None else None
        newline = '\r\n' if before is not None and '\r\n' in before else '\n'
        normalized = before.replace('\r\n', '\n') if before is not None else None
        if op == 'edit':
            if normalized is None: fail('File not found')
            old = a['old_string'].replace('\r\n', '\n')
            if not old: fail('old_string must not be empty')
            count = normalized.count(old)
            if count == 0: fail('FS_EDIT_NOT_FOUND: old_string not found')
            if count > 1 and not a.get('replace_all', False): fail('FS_AMBIGUOUS_EDIT: multiple matches; use replace_all')
            after = normalized.replace(old, a['new_string'].replace('\r\n', '\n'), -1 if a.get('replace_all', False) else 1)
        else: after = a['content'].replace('\r\n', '\n')
        data = after.replace('\n', newline).encode('utf-8')
        if len(data) > MAX_FILE: fail('Write exceeds 4 MiB')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix='.dsh-ssh-', dir=os.path.dirname(path))
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                if current is not None: os.fchmod(f.fileno(), stat.S_IMODE(os.stat(path).st_mode))
                f.flush()
                os.fsync(f.fileno())
            if version(path) != current: fail('FS_STALE_VERSION: file changed before write')
            if current is None:
                os.link(temp, path)
                os.unlink(temp)
            else: os.replace(temp, path)
        finally:
            if os.path.exists(temp): os.unlink(temp)
        value = {'path': path, 'before': normalized, 'after': after}
        if op == 'write': value['operation'] = 'create' if current is None else 'update'
        return {'path': path, 'version': version(path), 'value': value}
try:
    print(json.dumps({'ok': True, **main(json.load(sys.stdin))}, ensure_ascii=True))
except Exception as error:
    code = 'FS_NOT_FOUND' if isinstance(error, FileNotFoundError) else 'FS_IO_ERROR'
    print(json.dumps({'ok': False, 'error': str(error), 'code': code}, ensure_ascii=True))
`
