"""Replace a trailer's old end card with five seconds of its own scenery."""
import argparse
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from ambient_score import write_score


def render(source, output, replace_from=6.7, creator=None, ambient_score=False):
    assets = Path(__file__).resolve().parents[1] / 'assets'
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if source.resolve() == output:
        raise ValueError('Keep the original recording in a separate file')
    if creator is not None and not re.fullmatch(r'@[A-Za-z0-9_.-]{1,40}', creator):
        raise ValueError('Use a creator handle starting with @')
    # Local filenames in the filter are fixed. User paths never become shell code.
    with tempfile.TemporaryDirectory(prefix='ordersmp-outro-') as temporary:
        work = Path(temporary)
        for filename in ['order-logo.png', 'order-pixel.ttf']:
            shutil.copyfile(assets / filename, work / filename)
        duration = replace_from + 5
        (work / 'credit.txt').write_text(creator or '', encoding='utf8')
        if ambient_score:
            write_score(work / 'ambient.wav', duration)
        credit_filter = (",drawtext=fontfile=order-pixel.ttf:textfile=credit.txt:fontsize=30:"
            "fontcolor=0xF3E6C4@0.80:shadowcolor=black@0.75:shadowx=2:shadowy=2:x=64:y=1500") if creator else ''
        graph = (
            f'[0:v]split=2[original][scene];'
            f'[original]trim=end={replace_from},setpts=PTS-STARTPTS,fps=60,setsar=1,'
            f'fade=t=out:st={replace_from-0.28}:d=0.28[main];'
            '[scene]trim=start=1:end=4,setpts=1.666666667*(PTS-STARTPTS),fps=60,'
            'crop=1080:1380:0:270,scale=1080:1920:force_original_aspect_ratio=increase,'
            'crop=1080:1920,setsar=1,gblur=sigma=2,'
            'eq=brightness=-0.20:saturation=0.82,'
            'drawbox=x=0:y=0:w=iw:h=ih:color=black@0.20:t=fill[back];'
            '[1:v]scale=224:224:flags=neighbor,format=rgba[mark];'
            '[back][mark]overlay=x=(W-w)/2:y=490:shortest=1,'
            "drawtext=fontfile=order-pixel.ttf:text='OrderSMP':fontsize=82:fontcolor=0xF3E6C4:x=(w-tw)/2:y=790,"
            "drawtext=fontfile=order-pixel.ttf:text='3 NOVEMBER':fontsize=38:fontcolor=0xFFCC28:x=(w-tw)/2:y=935,"
            "drawtext=fontfile=order-pixel.ttf:text='Join the Discord':fontsize=30:fontcolor=0xF3E6C4:x=(w-tw)/2:y=1160,"
            "drawtext=fontfile=order-pixel.ttf:text='ordersmp.net':fontsize=30:fontcolor=0xF3E6C4:x=(w-tw)/2:y=1230,"
            'fade=t=in:st=0:d=0.6,fade=t=out:st=4.45:d=0.55[outro];'
            f'[main][outro]concat=n=2:v=1:a=0{credit_filter},format=yuv420p[video];'
            + (f'[2:a]atrim=end={duration},asetpts=PTS-STARTPTS[audio]' if ambient_score else
                f'[0:a]atrim=end={duration},asetpts=PTS-STARTPTS,afade=t=out:st=8.9:d=1.1,apad[audio]')
        )
        (work / 'filter.txt').write_text(graph, encoding='utf8')
        command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-i', str(source.resolve()), '-loop', '1', '-framerate', '60', '-i', 'order-logo.png',
            *(['-i', 'ambient.wav'] if ambient_score else []),
            '-filter_complex_script', 'filter.txt', '-map', '[video]', '-map', '[audio]',
            '-t', str(duration), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            '-map_metadata', '-1', '-movflags', '+faststart', '-y', str(output)]
        subprocess.run(command, cwd=work, check=True, timeout=1200)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--replace-from', type=float, default=6.7)
    parser.add_argument('--creator')
    parser.add_argument('--ambient-score', action='store_true')
    args = parser.parse_args()
    print(render(args.source, args.output, args.replace_from, args.creator, args.ambient_score))
