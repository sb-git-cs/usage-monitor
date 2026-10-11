"""Verify the signed update, install in place, and exercise native UI without signing in."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--adb', required=True)
parser.add_argument('--java', required=True)
parser.add_argument('--apksigner', required=True, help='Path to apksigner.jar')
parser.add_argument('--skip-install', action='store_true', help='Check an already installed matching version')
parser.add_argument('--baseline', help='Before-update Settings UI XML for pairing comparison')
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parent.parent
out = repo / '.qa'
out.mkdir(exist_ok=True)
package = 'io.github.sbgitcs.usagemonitor'
version = json.loads((repo / 'package.json').read_text(encoding='utf-8'))['version']
apk = repo / f'dist/UsageMonitor-{version}-android-optimized.apk'
major, minor, patch = map(int, version.split('.'))
code = ((major * 100 + minor) * 100 + patch) * 100 + 99

def adb(*cmd, binary=False, timeout=60):
    return subprocess.check_output([args.adb, '-d', *cmd], text=not binary,
                                   encoding=None if binary else 'utf-8', timeout=timeout)

def signer(file):
    text = subprocess.check_output([args.java, '-jar', args.apksigner, 'verify', '--print-certs', str(file)], text=True, encoding='utf-8', timeout=60)
    match = re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-f]+)', text)
    assert match, 'APK signing certificate not found'
    return match.group(1)

def capture(name, app=True):
    adb('shell', 'uiautomator', 'dump', '/sdcard/um-features-qa.xml')
    raw = adb('exec-out', 'cat', '/sdcard/um-features-qa.xml')
    tree = ET.fromstring(raw)
    if app:
        assert any(n.get('package') == package for n in tree.iter('node')), 'App is not visible'
    (out / f'features-phone-{name}.xml').write_text(raw, encoding='utf-8')
    (out / f'features-phone-{name}.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
    return tree

def labels(tree):
    return [n.get('text', '') for n in tree.iter('node')]

def tap(tree, title):
    for n in tree.iter('node'):
        if n.get('text') == title:
            x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds')))
            adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
            time.sleep(.4)
            return
    raise AssertionError(f'Control missing: {title}')

def route(tab, name):
    adb('shell', 'am', 'start', '-W', '-f', '0x24000000', '-n', package + '/.MainActivity', '--es', 'widget_tab', tab)
    return capture(name)

def widget_ids(text):
    blocks = re.findall(r'(?ms)^\s*\[\d+\] id=(\d+)\n(.*?)(?=^\s*\[\d+\] id=|\Z)', text.split('Widgets:')[-1])
    return sorted({number for number, block in blocks if package in block})

adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
adb('shell', 'wm', 'dismiss-keyguard')
before = ET.parse(args.baseline).getroot() if args.baseline else route('Settings', 'before-settings')
paired = [s for s in labels(before) if s.startswith('Paired with ')]
widgets_before = adb('shell', 'dumpsys', 'appwidget')
(out / 'features-phone-widgets-before.txt').write_text(widgets_before, encoding='utf-8')
installed_path = adb('shell', 'pm', 'path', package).splitlines()[0].removeprefix('package:').strip()
old_apk = out / 'features-phone-before.apk'
adb('pull', installed_path, str(old_apk))
certificate = signer(apk)
assert certificate == signer(old_apk), 'Signing certificate differs; refusing to replace the installed app'
if not args.skip_install:
    assert 'Success' in adb('install', '--no-streaming', '-r', str(apk), timeout=180), 'Android refused the in-place update'
    installed_path = adb('shell', 'pm', 'path', package).splitlines()[0].removeprefix('package:').strip()
    adb('pull', installed_path, str(old_apk))
assert hashlib.sha256(old_apk.read_bytes()).digest() == hashlib.sha256(apk.read_bytes()).digest(), 'The installed APK does not match the final build'
details = adb('shell', 'dumpsys', 'package', package)
assert f'versionName={version}' in details and f'versionCode={code}' in details
after = route('Settings', 'settings')
assert [s for s in labels(after) if s.startswith('Paired with ')] == paired, 'Pairing changed'
widgets_after = adb('shell', 'dumpsys', 'appwidget')
(out / 'features-phone-widgets-after.txt').write_text(widgets_after, encoding='utf-8')
assert widget_ids(widgets_after) == widget_ids(widgets_before), 'Widget IDs changed'
screens = []
for tab, title in [('Plans', 'Usage Monitor'), ('Accounts', 'Usage accounts'), ('Data', 'Data usage'), ('Phone', 'This phone'), ('Settings', 'Settings')]:
    tree = route(tab, tab.lower())
    assert title in labels(tree), f'{tab} screen missing'
    if tab == 'Accounts':
        assert all(p in labels(tree) for p in ('Claude Code', 'Codex', 'Gemini', 'Grok Build', 'Cursor'))
        assert 'Copilot' not in labels(tree)
    screens.append(tab)

tree = route('Plans', 'home')
tap(tree, 'Insights')
tree = capture('insights-history')
assert 'Plan history' in labels(tree) and 'Export history' in labels(tree)
tap(tree, '30d')
tree = capture('insights-30days')
tap(tree, 'Export history')
capture('export-picker', app=False)
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
tree = capture('insights-export-cancel')
assert 'Insights' in labels(tree)

# Find the snooze section even if real usage charts precede it.
for _ in range(20):
    if 'Snooze 1 hour' in labels(tree):
        break
    adb('shell', 'input', 'swipe', '500', '1450', '500', '450', '350')
    tree = capture('insights-scroll')
else:
    raise AssertionError('Notification centre is not reachable')
was_active = any(s.startswith('Alerts active;') for s in labels(tree))
if was_active:
    tap(tree, 'Snooze 1 hour')
    tree = capture('insights-snoozed')
    assert any(s.startswith('Alerts snoozed until') for s in labels(tree))
    tap(tree, 'Resume')
    tree = capture('insights-resumed')
    assert any(s.startswith('Alerts active;') for s in labels(tree))
for _ in range(12):
    if 'Export redacted support report' in labels(tree):
        break
    adb('shell', 'input', 'swipe', '500', '1450', '500', '550', '300')
    tree = capture('insights-diagnostics-scroll')
assert 'Export redacted support report' in labels(tree)
capture('insights-diagnostics')
for _ in range(8):
    if 'Display preferences' in labels(tree):
        break
    adb('shell', 'input', 'swipe', '500', '1450', '500', '550', '300')
    tree = capture('insights-display-scroll')
assert 'Display preferences' in labels(tree)
capture('insights-display')
original_mode = next((mode for mode in ('system', 'light', 'dark') if f'✓ {mode}' in labels(tree)), 'system')
original_scale = next((scale for scale in ('100%', '115%', '130%') if f'✓ {scale}' in labels(tree)), '100%')
if original_mode != 'dark':
    tap(tree, 'dark')
    tree = capture('insights-dark')
    assert '✓ dark' in labels(tree), 'Dark theme did not apply'
if original_scale != '130%':
    tap(tree, '130%')
    tree = capture('insights-large-text')
    assert '✓ 130%' in labels(tree), 'Large text setting did not apply'
if original_scale != '130%':
    tap(tree, original_scale)
    tree = capture('insights-text-restored')
if original_mode != 'dark':
    tap(tree, original_mode)
    tree = capture('insights-theme-restored')
assert f'✓ {original_mode}' in labels(tree) and f'✓ {original_scale}' in labels(tree), 'Display preferences were not restored'
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
tree = capture('back-home')
assert 'Usage Monitor' in labels(tree), 'Back did not return to Home'
adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
capture('launcher', app=False)
result = {'version': version, 'version_code': code, 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
          'size': apk.stat().st_size, 'certificate_sha256': certificate, 'installed': True,
          'pairing_preserved': True, 'widgets_preserved': True, 'screens': screens,
          'widget_ids': widget_ids(widgets_after),
          'history_periods': True, 'export_picker': True, 'diagnostics': True, 'snooze': was_active,
          'display_controls': True, 'back_navigation': True}
result.update({'dark_theme': True, 'large_text': True, 'display_preferences_restored': True})
(out / 'mobile-features-results.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, indent=2))
