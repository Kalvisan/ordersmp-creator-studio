import tempfile
import unittest
import json
import shutil
import subprocess
from fractions import Fraction
from unittest.mock import patch
from pathlib import Path
import worker
from worker import markers_for, owned_file, creator_handle


class Boundaries(unittest.TestCase):
    def test_credit_rejects_filter_injection_and_requires_exact_stored_handle(self):
        self.assertEqual(creator_handle('@Creator.One-2_3'), '@Creator.One-2_3')
        for value in (None, '', '@', 'creator', '@bad:drawtext', '@bad\n', '@' + 'a' * 41, '@%{filename}'):
            with self.assertRaises(ValueError):
                worker.process({'creatorHandle': value, 'sourcePath': 'not-accessed.mp4'})

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg is required for the real render check')
    def test_real_credit_render_is_visible_literal_and_preserves_sixty_fps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inbox, renders = root / 'inbox', root / 'renders'
            inbox.mkdir()
            source = inbox / 'source.mp4'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                'color=black:s=1080x1920:r=60:d=3', '-an', '-c:v', 'libx264', '-threads', '1',
                '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', str(source)], check=True, timeout=60)
            real_run = subprocess.run
            credit_commands = []

            def run(command, **kwargs):
                if command[0] == 'ffmpeg' and '-vf' in command:
                    credit_commands.append(command)
                    self.assertNotIn('@b1oeorblue', command[command.index('-vf') + 1])
                    self.assertEqual((Path(kwargs['cwd']) / 'creator-credit.txt').read_text(), '@b1oeorblue')
                    self.assertIn('expansion=none', command[command.index('-vf') + 1])
                return real_run(command, **kwargs)

            with patch.object(worker, 'INBOX', inbox), patch.object(worker, 'RENDERS', renders), \
                 patch.object(worker, 'CREDIT_FONT', Path(__file__).resolve().parents[1] / 'assets' / 'order-pixel.ttf'), \
                 patch.object(worker, 'transcript', return_value=''), patch.object(worker.subprocess, 'run', side_effect=run):
                clips = worker.process({'sourcePath': 'source.mp4', 'creatorHandle': '@b1oeorblue', 'markers': []})
            self.assertEqual(len(credit_commands), 1)
            self.assertEqual(clips[0]['creatorHandle'], '@b1oeorblue')
            final = renders / clips[0]['path']
            data = json.loads(real_run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(final)],
                check=True, capture_output=True, timeout=30).stdout)
            video = next(item for item in data['streams'] if item['codec_type'] == 'video')
            self.assertEqual((video['width'], video['height']), (1080, 1920))
            self.assertEqual(Fraction(video['avg_frame_rate']), Fraction(60))
            pixels = real_run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(final), '-frames:v', '1',
                '-vf', 'crop=600:90:40:1620', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
                check=True, capture_output=True, timeout=30).stdout
            cream = sum(pixels[index] > 180 and pixels[index + 1] > 170 and pixels[index + 2] > 140
                for index in range(0, len(pixels), 3))
            self.assertGreater(cream, 40, 'The cream creator credit must be visible over the black source')

    def test_clip_limits(self):
        self.assertEqual(markers_for(100, [{'start': 10, 'end': 45}]), [(10, 45)])
        self.assertEqual(markers_for(10.304, [{'start': 0, 'end': 10.304}]), [(0, 10.304)])
        for value in [[{'start': 0, 'end': 61}], [{'start': -1, 'end': 30}],
                      [{'start': 90, 'end': 120}], [{'start': float('nan'), 'end': 30}],
                      [{'start': 1, 'end': 2}], [{}] * 11]:
            with self.assertRaises((ValueError, KeyError)):
                markers_for(100, value)

    def test_paths_cannot_escape_or_follow_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.mp4'
            source.write_bytes(b'video')
            self.assertEqual(owned_file(root, 'source.mp4'), source)
            for name in ['../source.mp4', '/source.mp4', 'a/b.mp4', 'https://host/video.mp4', 'missing.mp4']:
                with self.assertRaises(ValueError):
                    owned_file(root, name)


if __name__ == '__main__':
    unittest.main()
