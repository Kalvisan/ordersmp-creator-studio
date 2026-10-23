"""Keep the renderer's one credential in a private, ephemeral file."""
import os
from pathlib import Path
import sys

os.umask(0o077)
existing = os.environ.get('CREATOR_WORKER_TOKEN_FILE')
if existing:
    path = Path(existing)
    if path.parent != Path('/config') or path.is_symlink() or not path.is_file() or len(path.read_text().strip()) < 32:
        raise RuntimeError('Invalid managed worker credential')
    os.environ.pop('CREATOR_WORKER_TOKEN', None)
    os.execv(sys.executable, [sys.executable, '/app/worker.py'])
token = os.environ.pop('CREATOR_WORKER_TOKEN', '')
if len(token) < 32 or any(character in token for character in ('\r', '\n', '\x00')):
    raise RuntimeError('A valid worker credential is required')
directory = Path('/tmp/creator-secrets')
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
filename = directory / 'worker-token'
with filename.open('x') as handle:
    handle.write(token)
os.environ['CREATOR_WORKER_TOKEN_FILE'] = str(filename)
os.execv(sys.executable, [sys.executable, '/app/worker.py'])
