import tempfile
import unittest
from pathlib import Path
from worker import markers_for, owned_file


class Boundaries(unittest.TestCase):
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
