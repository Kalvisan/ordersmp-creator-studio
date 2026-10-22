"""Bounded FFmpeg worker. Candidate clips always require a human review."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

os.umask(0o007)
INBOX = Path(os.environ.get('CREATOR_INBOX', '/media/inbox'))
RENDERS = Path(os.environ.get('CREATOR_RENDERS', '/media/renders'))
ID = re.compile(r'^[a-zA-Z0-9-]{1,80}(?:\.(?:mp4|mkv|webm))?$')
MAX_DURATION = 12 * 3600


def owned_file(root, relative):
    if not isinstance(relative, str) or not ID.fullmatch(relative):
        raise ValueError('Invalid media identifier')
    path = root / relative
    if path.is_symlink() or not path.is_file() or path.resolve().parent != root.resolve():
        raise ValueError('Media file is unavailable')
    return path


def probe(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-show_format', '-show_streams', '-of', 'json', str(path)], capture_output=True,
        timeout=60, check=True)
    data = json.loads(result.stdout)
    duration = float(data.get('format', {}).get('duration', 0))
    formats = data.get('format', {}).get('format_name', '').split(',')
    videos = [s for s in data.get('streams', []) if s.get('codec_type') == 'video']
    if not any(f in formats for f in ('mov', 'mp4', 'matroska', 'webm')) or not videos:
        raise ValueError('Upload an MP4, MKV or WebM video')
    if not math.isfinite(duration) or not 3 <= duration <= MAX_DURATION:
        raise ValueError('Video must last between 3 seconds and 12 hours')
    if any(int(v.get('width', 0)) * int(v.get('height', 0)) > 3840 * 2160 for v in videos):
        raise ValueError('Use a video at 4K or below')
    return duration, any(s.get('codec_type') == 'audio' for s in data['streams'])


def markers_for(duration, markers):
    if not isinstance(markers, list) or len(markers) > 10:
        raise ValueError('Choose up to 10 clip ranges')
    answer = []
    for item in markers:
        start, end = float(item['start']), float(item['end'])
        if not all(math.isfinite(x) for x in (start, end)) or not 0 <= start < end <= duration + 0.05:
            raise ValueError('Clip range is outside the video')
        if not 3 <= end - start <= 60:
            raise ValueError('Each clip must last 3 to 60 seconds')
        answer.append((start, min(end, duration)))
    return answer


def ready_portrait(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-show_streams', '-of', 'json', str(path)], capture_output=True, timeout=60, check=True)
    streams = json.loads(result.stdout)['streams']
    video = next(s for s in streams if s.get('codec_type') == 'video')
    audio = [s for s in streams if s.get('codec_type') == 'audio']
    rate = video.get('avg_frame_rate', '0/1').split('/')
    fps = float(rate[0]) / max(float(rate[1]), 1)
    return (video.get('width') == 1080 and video.get('height') == 1920
        and video.get('codec_name') == 'h264' and video.get('pix_fmt') == 'yuv420p'
        and 1 <= fps <= 60 and all(s.get('codec_name') == 'aac' for s in audio))


def candidates(path, duration, audio):
    """Suggest up to three loud moments, with room for context before each one."""
    if duration <= 60:
        return [(0, duration)]
    if not audio:
        return [(max(0, duration / 2 - 20), min(duration, duration / 2 + 20))]
    command = ['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-threads', '1',
        '-protocol_whitelist', 'file,pipe', '-i', str(path), '-vn', '-ac', '1', '-ar', '8000',
        '-af', 'asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f', 'null', '-']
    # A twelve-hour source yields at most 43,200 small metadata records.
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=4 * 3600, check=True, text=True)
    peaks, at = [], 0.0
    for line in result.stdout.splitlines():
        if 'pts_time:' in line:
            at = float(line.split('pts_time:', 1)[1].split()[0])
        elif line.startswith('lavfi.astats.Overall.RMS_level='):
            level = float(line.partition('=')[2])
            if math.isfinite(level):
                peaks.append((level, at))
    chosen = []
    for _, at in sorted(peaks, reverse=True):
        start = max(0, min(at - 12, duration - 40))
        if all(abs(start - old[0]) >= 60 for old in chosen):
            chosen.append((start, min(duration, start + 40)))
        if len(chosen) == 3:
            break
    return sorted(chosen or [(0, min(40, duration))])


def transcript(path, language):
    # Models are provisioned on disk. No runtime model download or paid API call.
    model_dir = os.environ.get('CREATOR_WHISPER_MODEL_DIR')
    if not model_dir:
        return ''
    from faster_whisper import WhisperModel
    model = WhisperModel(model_dir, device='cpu', compute_type='int8', cpu_threads=1,
        num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(str(path), language=language if language in ('en', 'lv') else None,
        beam_size=1, vad_filter=True)
    return ' '.join(segment.text.strip() for segment in segments)[:12000]


def process(job):
    source = owned_file(INBOX, job['sourcePath'])
    duration, audio = probe(source)
    ranges = markers_for(duration, job.get('markers', [])) or candidates(source, duration, audio)
    preserve = len(ranges) == 1 and ranges[0] == (0, duration) and duration <= 60 and ready_portrait(source)
    results = []
    RENDERS.mkdir(parents=True, exist_ok=True)
    for start, end in ranges:
        name = f'{uuid.uuid4()}.mp4'
        final = RENDERS / name
        temporary = RENDERS / f'.{name}.part.mp4'
        # Preserve the whole game view. Reviewers can reject or choose another range.
        video_filter = ('scale=1080:1920:force_original_aspect_ratio=decrease,'
            'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x1a1a1a,setsar=1,fps=30')
        command = ['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-threads', '1',
            '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-ss', str(start),
            '-i', str(source), '-t', str(end - start), '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', video_filter, '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast',
            '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
            '-map_metadata', '-1', '-movflags', '+faststart', '-y', str(temporary)]
        if preserve:
            command = ['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error',
                '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map', '0:v:0',
                '-map', '0:a:0?', '-c', 'copy', '-map_metadata', '-1', '-movflags', '+faststart',
                '-y', str(temporary)]
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=1800)
            rendered_duration, _ = probe(temporary)
            text = transcript(temporary, job.get('language'))
            with temporary.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            temporary.chmod(0o640)
            temporary.replace(final)
            results.append(dict(path=name, sha256=digest, start=start, end=end,
                duration=rendered_duration, transcript=text))
        finally:
            temporary.unlink(missing_ok=True)
    return results


def request(method, data=None):
    token = Path(os.environ['CREATOR_WORKER_TOKEN_FILE']).read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:16080/creator/internal/jobs',
        data=json.dumps(data).encode() if data is not None else None, method=method,
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read(2 * 1024 * 1024) or b'null')


def run():
    while True:
        try:
            job = request('GET')
            if not job:
                time.sleep(10)
                continue
            try:
                clips = process(job)
                request('POST', {'id': job['id'], 'leaseToken': job['leaseToken'], 'clips': clips})
                print('Clip batch prepared for review', flush=True)
            except Exception:
                # Keep private paths, captions and API responses out of shared logs.
                request('POST', {'id': job['id'], 'leaseToken': job['leaseToken'],
                    'error': 'Processing failed. Check the source video and ranges.'})
        except (OSError, ValueError, urllib.error.URLError):
            print('Worker is waiting for the private gateway', flush=True)
            time.sleep(20)


if __name__ == '__main__':
    run()
