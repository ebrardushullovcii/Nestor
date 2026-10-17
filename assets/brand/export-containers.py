from pathlib import Path
from PIL import Image
import subprocess, json, struct, xml.etree.ElementTree as ET, shutil, tempfile

ROOT = Path(__file__).resolve().parent
def ico(output, directory, names):
    images = [Image.open(directory / filename).convert('RGBA') for filename in names]
    sizes = [image.size for image in images]
    images[-1].save(output, format='ICO', sizes=sizes, append_images=images[:-1])
    with Image.open(output) as container:
        assert container.ico.sizes() == set(sizes), (output, container.ico.sizes())
        for size in sizes:
            frame = container.ico.getimage(size)
            assert frame.size == size and frame.mode == 'RGBA'
    return sizes

ico(ROOT/'desktop/windows/icon.ico', ROOT/'desktop/windows', [f'icon-{n}.png' for n in [16,20,24,32,40,48,64,128,256]])
ico(ROOT/'web/favicon.ico', ROOT/'web', [f'favicon-{n}.png' for n in [16,32,48]])
# Use Apple's native encoder for all standard and Retina representations.
subprocess.run(['iconutil','-c','icns',str(ROOT/'desktop/macos/Nestor.iconset'),'-o',str(ROOT/'desktop/macos/icon.icns')],check=True)
icns=(ROOT/'desktop/macos/icon.icns').read_bytes()
assert icns[:4] == b'icns' and struct.unpack('>I', icns[4:8])[0] == len(icns)
offset=8; types=[]
while offset<len(icns):
    tag=icns[offset:offset+4].decode('ascii')
    length=struct.unpack('>I',icns[offset+4:offset+8])[0]
    assert length >= 8 and offset+length <= len(icns)
    types.append(tag)
    offset+=length
assert 'ic10' in types, types
assert offset==len(icns)
with tempfile.TemporaryDirectory(prefix='nestor-icns-check-') as directory:
    decoded=Path(directory)/'Decoded.iconset'
    subprocess.run(['iconutil','-c','iconset',str(ROOT/'desktop/macos/icon.icns'),'-o',str(decoded)],check=True)
    for original in (ROOT/'desktop/macos/Nestor.iconset').glob('*.png'):
        with Image.open(original) as expected, Image.open(decoded/original.name) as actual:
            assert actual.size==expected.size
            a=actual.convert('RGBA'); b=expected.convert('RGBA')
            # Legacy small representations normalize RGB at antialiased edges.
            # Their alpha and fully opaque colors must remain exact.
            assert a.getpixel((0,0))[3]==0
            assert a.getchannel('A').tobytes()==b.getchannel('A').tobytes()
            for p,q in zip(a.getdata(),b.getdata()):
                if p[3]==255:assert p[:3]==q[:3]

inventory=json.loads((ROOT/'inventory.json').read_text())
for entry in inventory:
    with Image.open(ROOT/entry['path']) as image:
        assert image.size==(entry['width'],entry['height'])
        if entry['transparent']:
            assert image.mode=='RGBA', entry
            assert image.getpixel((0,0))[3]==0, entry
            assert image.getchannel('A').getextrema()==(0,255), entry
        else:
            assert image.mode=='RGB' or image.getchannel('A').getextrema()==(255,255), entry
for file in (ROOT/'source').glob('*.svg'):
    tree=ET.parse(file)
    assert not any(e.tag.endswith('image') or e.tag.endswith('text') for e in tree.iter()), file

# Check that the ring and all three stones stay separate shapes even at 16px.
def components(image):
    alpha=image.convert('RGBA').getchannel('A')
    w,h=image.size
    remaining={(x,y) for y in range(h) for x in range(w) if alpha.getpixel((x,y))>=128}
    groups=[]
    while remaining:
        first=remaining.pop(); group={first}; stack=[first]
        while stack:
            x,y=stack.pop()
            for p in [(x-1,y),(x+1,y),(x,y-1),(x,y+1)]:
                if p in remaining:remaining.remove(p);group.add(p);stack.append(p)
        groups.append(group)
    return groups
for n in [16,32,48,64,128]:
    image=Image.open(ROOT/f'web/favicon-{n}.png')
    count=len(components(image))
    assert count==4, (n,count)
wordmark=Image.open(ROOT/'in-app/wordmark-1280.png')
assert len(components(wordmark))==9, 'Wordmark must retain six letters and three separate stones.'

# The maskable foreground must fit the circle with radius 40% of the canvas.
foreground=Image.open(ROOT/'desktop/macos/icon-composer-foreground.png')
alpha=foreground.getchannel('A')
for y in range(1024):
    for x in range(1024):
        if alpha.getpixel((x,y))>=128:
            assert (x-512)**2+(y-512)**2 <= (409.6)**2
print(f'Validated {len(inventory)} PNG sizes and transparency; all favicons retain four separate shapes.')
print('Validated Windows ICO: 16,20,24,32,40,48,64,128,256; favicon ICO: 16,32,48.')
print('Validated macOS ICNS container and 1024px representation:', ','.join(types))
print('Validated outlined SVGs and maskable icon safe zone.')
print('Validated wordmark: six complete letter shapes plus three separate stones.')
build=ROOT/'integration/electron-build'
build.mkdir(parents=True,exist_ok=True)
shutil.copy2(ROOT/'desktop/windows/icon.ico',build/'icon.ico')
shutil.copy2(ROOT/'desktop/macos/icon.icns',build/'icon.icns')
shutil.copy2(ROOT/'desktop/windows/icon-1024.png',build/'icon.png')
shutil.copy2(ROOT/'source/app-icon.svg',build/'icon.svg')
shutil.copytree(ROOT/'desktop/linux',build/'icons',dirs_exist_ok=True)
for name in ['wordmark','wordmark-on-dark','mark','mark-on-dark']:
    shutil.copy2(ROOT/'in-app'/f'{name}.svg',ROOT/'web'/f'{name}.svg')
for n in [320,640,1280]:
    shutil.copy2(ROOT/'in-app'/f'wordmark-{n}.png',ROOT/'web'/f'wordmark-{n}.png')
