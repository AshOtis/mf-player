"""Build the Obsidian plugin into dist/ (main.js, styles.css with embedded IBM Plex Mono, manifest.json).
No dependencies: python3 build.py"""
import base64, pathlib, shutil
R = pathlib.Path(__file__).resolve().parent; out = R / 'dist'; out.mkdir(exist_ok=True)
faces = [('ExtraLight', 200, 'normal'), ('Regular', 400, 'normal'), ('Italic', 400, 'italic'), ('SemiBold', 600, 'normal')]
css = []
for name, w, style in faces:
    b = base64.b64encode((R / 'fonts' / f'IBMPlexMono-{name}-Latin1.woff2').read_bytes()).decode()
    css.append(f'@font-face {{ font-family: "MFP Plex Mono"; font-weight: {w}; font-style: {style}; font-display: swap; src: url(data:font/woff2;base64,{b}) format("woff2"); }}')
src = (R / 'src' / 'styles.css').read_text(encoding='utf-8')
(out / 'styles.css').write_text(src.replace('/*@FONTS@*/', '\n'.join(css)), encoding='utf-8')
shutil.copy(R / 'src' / 'main.js', out / 'main.js')
shutil.copy(R / 'manifest.json', out / 'manifest.json')
print('dist/ ready: main.js, manifest.json, styles.css')
