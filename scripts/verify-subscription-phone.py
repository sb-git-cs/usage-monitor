"""Capture the real app and Glance widget in an isolated demo package on a connected phone.

Build the debug app with scripts/android-demo.gradle, then pass --apk. Only the
demo package's preferences are written; the installed Usage Monitor stays intact.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

parser = argparse.ArgumentParser()
parser.add_argument('--adb', required=True)
parser.add_argument('--apk', required=True)
parser.add_argument('--skip-install', action='store_true', help='Verify the already installed demo APK instead')
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parent.parent
out = repo / 'docs/screenshots/android'
out.mkdir(parents=True, exist_ok=True)
package = 'io.github.sbgitcs.usagemonitor.subscriptiondemo'
main = package + '/io.github.sbgitcs.usagemonitor.MainActivity'

def adb(*cmd, binary=False, timeout=60):
    return subprocess.check_output([args.adb, '-d', *cmd], text=not binary,
        encoding=None if binary else 'utf-8', timeout=timeout)

def iso(days):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat().replace('+00:00', 'Z')

def window(kind, label, used, days=3):
    return dict(kind=kind, label=label, used_pct=used, resets_at=iso(days) if days else None)

def readings(regime):
    ps = []
    for ident, name, used in [('claude', 'Claude Code', 42), ('codex', 'Codex', 18), ('gemini', 'Gemini', 61), ('grok', 'Grok Build', 35), ('cursor', 'Cursor', 54)]:
        p = dict(id=ident, display_name=name, status=dict(state='ok'), source='phone', fetched_at=iso(0),
            subscription_regime=regime, account_id='demo-' + ident, windows=[window('monthly' if ident == 'cursor' else 'weekly', 'Monthly' if ident == 'cursor' else 'Weekly', used)])
        if ident == 'grok':
            p['shared_weekly'] = window('weekly', 'Weekly', 35)
            p['windows'].append(window('credits', 'Credits $12.50', None, 0))
        ps.append(p)
    return json.dumps(dict(providers=ps))

def configure(regime, scale=1):
    adb('shell', 'am', 'force-stop', package)
    root = ET.Element('map')
    for key, val in [('subscription_regime', regime), ('theme_mode', 'dark'), ('direct', readings(regime))]:
        ET.SubElement(root, 'string', name=key).text = val
    for key, val in [('auto_update', 'false'), ('asked_notifications', 'true'), ('plan_alerts', 'false')]:
        ET.SubElement(root, 'boolean', name=key, value=val)
    ET.SubElement(root, 'float', name='text_scale', value=str(scale))
    prefs = repo / '.qa/subscription-demo-prefs.xml'
    prefs.write_bytes(ET.tostring(root, encoding='utf-8', xml_declaration=True))
    adb('push', str(prefs), '/data/local/tmp/um-subscription-demo.xml')
    adb('shell', 'run-as', package, 'mkdir', '-p', 'shared_prefs')
    adb('shell', 'run-as', package, 'cp', '/data/local/tmp/um-subscription-demo.xml', 'shared_prefs/settings.xml')

def capture(name, required):
    time.sleep(2)
    adb('shell', 'uiautomator', 'dump', '/sdcard/um-subscription-demo-ui.xml')
    tree = ET.fromstring(adb('exec-out', 'cat', '/sdcard/um-subscription-demo-ui.xml'))
    labels = [n.get('text', '') for n in tree.iter('node')]
    assert any(required in text for text in labels), (name, required, labels)
    (out / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
    return tree

if not args.skip_install:
    adb('install', '--no-streaming', '-r', args.apk, timeout=150)
installed = adb('shell', 'pm', 'path', package).strip().removeprefix('package:')
assert installed.startswith('/data/app/') and installed.endswith('/base.apk'), installed
assert hashlib.sha256(adb('exec-out', 'cat', installed, binary=True)).digest() == hashlib.sha256(pathlib.Path(args.apk).read_bytes()).digest(), 'The installed demo APK differs from the build'
adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
adb('shell', 'wm', 'dismiss-keyguard')
adb('shell', 'appwidget', 'grantbind', '--package', package, '--user', '0')
results = []
for regime in ['legacy', 'combined']:
    configure(regime)
    adb('shell', 'am', 'start', '-W', '-n', main, '--es', 'widget_tab', 'Plans')
    tree = capture('native-home-' + regime, 'X Subscription' if regime == 'combined' else 'Grok Build')
    labels = [n.get('text', '') for n in tree.iter('node')]
    assert ('Cursor' in labels) == (regime == 'legacy')
    if regime == 'combined': assert any('Additional Usage $12.50' in text for text in labels)
    adb('shell', 'am', 'start', '-W', '-f', '0x24000000', '-n', main, '--es', 'widget_tab', 'Settings')
    tree = capture('native-settings-' + regime, 'Use combined X Subscription')
    toggles = [n for n in tree.iter('node') if n.get('checkable') == 'true']
    assert toggles and toggles[0].get('checked') == str(regime == 'combined').lower()
    # Exercise the actual toggle, then restart and inspect the saved setting.
    toggle = toggles[0]
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', toggle.get('bounds')))
    adb('shell', 'input', 'tap', str((x1 + x2)//2), str((y1 + y2)//2))
    time.sleep(.6)
    saved = ET.fromstring(adb('exec-out', 'run-as', package, 'cat', 'shared_prefs/settings.xml'))
    assert next(n.text for n in saved if n.get('name') == 'subscription_regime') == ('legacy' if regime == 'combined' else 'combined')
    adb('shell', 'input', 'tap', str((x1 + x2)//2), str((y1 + y2)//2))
    time.sleep(.6)
    adb('shell', 'am', 'force-stop', package)
    adb('shell', 'am', 'start', '-W', '-n', main, '--es', 'widget_tab', 'Settings')
    capture('native-settings-' + regime, 'Use combined X Subscription')
    adb('shell', 'am', 'start', '-W', '-n', package + '/io.github.sbgitcs.usagemonitor.SubscriptionWidgetCaptureActivity')
    widget = capture('native-widget-' + regime, 'X Subscription' if regime == 'combined' else 'Grok Build')
    if regime == 'combined': assert any('Additional Usage $12.50' in n.get('text', '') for n in widget.iter('node'))
    night = re.search(r'Night mode: (\w+)', adb('shell', 'cmd', 'uimode', 'night')).group(1)
    try:
        adb('shell', 'cmd', 'uimode', 'night', 'yes')
        adb('shell', 'am', 'force-stop', package)
        adb('shell', 'am', 'start', '-W', '-n', package + '/io.github.sbgitcs.usagemonitor.SubscriptionWidgetCaptureActivity')
        capture('native-widget-' + regime + '-dark', 'X Subscription' if regime == 'combined' else 'Grok Build')
    finally:
        adb('shell', 'cmd', 'uimode', 'night', night)
    results.append(regime)
configure('combined', 1.3)
adb('shell', 'am', 'start', '-W', '-n', main, '--es', 'widget_tab', 'Plans')
capture('native-home-combined-large-text', 'X Subscription')
adb('shell', 'am', 'start', '-W', '-f', '0x24000000', '-n', main, '--es', 'widget_tab', 'Settings')
capture('native-settings-combined-large-text', 'Use combined X Subscription')
(repo / '.qa/subscription-phone-results.json').write_text(json.dumps(dict(package=package, regimes=results,
    native_home=True, native_settings=True, native_glance_widget=True, larger_text=True, production_profile_untouched=True), indent=2))
adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
