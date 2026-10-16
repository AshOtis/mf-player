"""Build the Obsidian plugin into dist/ (main.js, styles.css, manifest.json). No dependencies: python3 build.py
No fonts are embedded: the plugin uses IBM Plex Mono if it's installed, otherwise Obsidian's monospace font."""
import pathlib, shutil
R = pathlib.Path(__file__).resolve().parent; out = R / 'dist'; out.mkdir(exist_ok=True)
src = (R / 'src' / 'styles.css').read_text(encoding='utf-8')
(out / 'styles.css').write_text(src.replace('/*@FONTS@*/\n', '').replace('/*@FONTS@*/', ''), encoding='utf-8')
shutil.copy(R / 'src' / 'main.js', out / 'main.js')
shutil.copy(R / 'manifest.json', out / 'manifest.json')
print('dist/ ready: main.js, manifest.json, styles.css')
