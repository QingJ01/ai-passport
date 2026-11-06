#!/usr/bin/env python3
"""Host tests for bounded USB framing and nonsecret device diagnostics."""
import importlib.util
import json
import re
import uuid
from pathlib import Path
import subprocess
import unittest
import tempfile
import shutil

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('device_tools', ROOT / 'tools/agent_pet_device.py')
device = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device)


class FakePort:
    """Minimal serial stand-in that answers exactly like the firmware would."""

    def __init__(self, configured_after=1):
        self.pending = bytearray()
        self.buffer = ''
        self.infolen = 0
        self.confirms = 0
        self.link_requests = 0
        self.configured_after = configured_after

    def write(self, data):
        self.buffer += data.decode('utf-8')
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            document = json.loads(line)
            if document['type'] == 'device.info':
                self.infolen += 1
                payload = {'device_id': 'passport-1', 'view_epoch': 'fixture-epoch',
                           'usb_window_s': 120, 'keys_seen': 0, 'menu': False,
                           'configured': self.infolen > self.configured_after,
                           'network_count': 1 if self.infolen > self.configured_after else 0}
                self.pending += (json.dumps({'v': 1, 'type': 'device.info',
                                             'payload': payload}) + '\n').encode()
            elif document['type'] == 'link.request':
                self.link_requests += 1
            elif document['type'] == 'setup':
                self.confirms += 1
                self.pending += (json.dumps({'v': 1, 'type': 'setup.result',
                                             'payload': {'status': 'confirm_on_device'}}) + '\n').encode()

    def flush(self):
        pass

    def read(self, size):
        chunk = bytes(self.pending[:size])
        del self.pending[:size]
        return chunk


@unittest.skipUnless(shutil.which('node') and shutil.which('openssl'), 'Node.js and OpenSSL create the temporary bridge')
class ProvisioningFlowTest(unittest.TestCase):
    """Uses a throwaway bridge configuration, never the developer's .agent-pet/."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='agent-pet-provision-')
        folder = Path(cls.directory.name) / 'bridge'
        subprocess.run(['node', str(ROOT / 'services/src/setup.mjs'), str(folder)], check=True,
                       capture_output=True)
        cls.config = folder / 'config.json'
        config = json.loads(cls.config.read_text())
        config['public_endpoint'] = 'wss://mac.local:7443/v1/device'
        cls.config.write_text(json.dumps(config))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_payload_is_sent_and_confirmation_is_awaited(self):
        port = FakePort()
        result = device.provision(port, self.config, 'HomeNet',
                                  'secret-pass', 3, 1, say=lambda *_: None)
        self.assertEqual(result['status'], 'configured')
        self.assertEqual(port.confirms, 1, 'exactly one setup frame is written')
        self.assertEqual(result['device']['network_count'], 1)
        self.assertNotIn('secret-pass', json.dumps(result))

    def test_missing_confirmation_reports_timeout_without_claiming_success(self):
        port = FakePort(configured_after=10 ** 6)
        result = device.provision(port, self.config, 'HomeNet',
                                  'secret-pass', 3, 1, say=lambda *_: None)
        self.assertEqual(result['status'], 'timeout_waiting_for_confirmation')


class ProvisioningPayloadTest(unittest.TestCase):
    fixture = ROOT / 'tests/fixtures/agent-pet-setup.json'

    def build(self, **overrides):
        fields = dict(ssid='AgentPetFixture', password='fixture-network-key',
                      endpoint='wss://192.0.2.10:7443/v1/device', token='fixture-'+'0'*56,
                      ca_pem='-----BEGIN CERTIFICATE-----\nMIIBfixturecertificatebody\n-----END CERTIFICATE-----\n',
                      server_name='agentpet.local', device_id='passport-fixture',
                      time_url='http://192.0.2.10:7444/v1/time', time_issuer='agentpet-fixture',
                      enrollment_key_pem='-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfixture\n-----END PUBLIC KEY-----\n',
                      utc_seconds=1762300000)
        fields.update(overrides)
        return device.build_setup_message(**fields)

    def test_committed_fixture_matches_the_builder(self):
        expected = self.fixture.read_text().rstrip('\n')
        self.assertEqual(self.build(), expected,
                         'tests/test_agent_pet_config.c parses this fixture with the firmware parser')

    def test_message_stays_inside_the_device_frame_limit(self):
        ca = ('-----BEGIN CERTIFICATE-----\n' + 'MIIB' * 400 + '\n-----END CERTIFICATE-----\n')
        message = self.build(ca_pem=ca)
        self.assertLessEqual(len(message.encode()), device.SETUP_LIMIT)
        self.assertIn('\\n', message, 'PEM newlines must be escaped for the device parser')

    def test_rejects_payloads_the_firmware_would_refuse(self):
        for overrides in ({'token': 'short'}, {'endpoint': 'http://192.0.2.10:7443/v1/device'},
                          {'ssid': ''}, {'ssid': 'x' * 33}, {'password': 'p' * 65},
                          {'ca_pem': 'not a certificate'}, {'utc_seconds': 1},
                          {'replace_slot': 3}, {'transport': 'other'},
                          {'time_url': 'wss://192.0.2.10:7444/v1/time'}):
            with self.assertRaises(ValueError):
                self.build(**overrides)
        # The firmware treats signed time as optional, so the builder stays aligned
        # with it instead of rejecting a profile the device would accept.
        self.assertIn('"time_bootstrap_url":""',
                      self.build(time_url='', time_issuer='', enrollment_key_pem=''))


class ProvisioningPreflightTest(unittest.TestCase):
    def test_summary_never_contains_secrets_and_flags_loopback(self):
        summary = device.preflight_summary(ROOT / '.agent-pet/config.json', 'HomeNet', 'secret-pass')
        self.assertEqual(summary['limit_bytes'], device.SETUP_LIMIT)
        self.assertLess(summary['payload_bytes'], device.SETUP_LIMIT)
        self.assertEqual(summary['ssid_bytes'], 7)
        text = json.dumps(summary)
        self.assertNotIn('secret-pass', text)
        self.assertNotIn('BEGIN CERTIFICATE', text)
        if summary['endpoint_host'] in ('127.0.0.1', 'localhost', '::1'):
            self.assertFalse(summary['endpoint_usable_by_device'],
                             'a loopback bridge cannot be reached by the device')


class DeviceToolsTest(unittest.TestCase):
    def test_serial_cannot_replace_host_authentication(self):
        for kind in ('auth', 'hello', 'setup', 'source.event'):
            line = json.dumps({'v': 1, 'type': kind, 'payload': {}}).encode()
            self.assertIsNone(device.upstream_command(line))
        action = {'v': 1, 'type': 'action.prepare', 'payload': {'target_id': 'synthetic-task'}}
        self.assertEqual(device.upstream_command(json.dumps(action).encode()), action)
        self.assertIsNone(device.upstream_command(b'{"v":1,"type":[],"payload":{}}'))
        self.assertIsNone(device.upstream_command(b'{"v":true,"type":"action","payload":{}}'))

    def test_serial_privacy_control_requires_bounded_epoch_and_real_mode(self):
        command = {'v': 1, 'type': 'view.configure', 'payload': {'mode': 'public', 'view_epoch': 'fresh-epoch'}}
        self.assertIsNotNone(device.upstream_command(json.dumps(command).encode()))
        command['payload']['view_epoch'] = 'x' * 65
        self.assertIsNone(device.upstream_command(json.dumps(command).encode()))
        command['payload'] = {'mode': False, 'view_epoch': 'fresh-epoch'}
        self.assertIsNone(device.upstream_command(json.dumps(command).encode()))

    def test_frames_from_a_previous_epoch_are_dropped_not_fatal(self):
        frame = {'v': 1, 'type': 'heartbeat', 'view_epoch': 'old-epoch', 'payload': {}}
        line = json.dumps(frame).encode()
        self.assertEqual(device.bridge_frame(line, 'old-epoch'), frame)
        self.assertIsNone(device.bridge_frame(line, 'new-epoch'),
                          'a frame left over from a discarded projection must not reach the device')
        self.assertIsNone(device.bridge_frame(b'{"v":1,"type":"heartbeat"}', 'new-epoch'))
        self.assertIsNone(device.bridge_frame(b'[1]', 'new-epoch'))
        self.assertIsNone(device.bridge_frame(b'not json', 'new-epoch'))

    def test_forwarder_uses_the_bind_address_not_the_bonjour_name(self):
        lan = {'public_endpoint': 'wss://mac.local:7443/v1/device', 'bind': '192.168.5.3'}
        self.assertEqual(device.local_endpoint(lan), 'wss://192.168.5.3:7443/v1/device')
        loop = {'public_endpoint': 'wss://127.0.0.1:7443/v1/device', 'bind': '127.0.0.1'}
        self.assertEqual(device.local_endpoint(loop), 'wss://127.0.0.1:7443/v1/device')
        self.assertEqual(device.local_endpoint({'public_endpoint': 'wss://x.local:7443/v1/device'}),
                         'wss://x.local:7443/v1/device')

    def test_auto_port_picks_the_espressif_device(self):
        class P:
            def __init__(self, device, vid):
                self.device, self.vid = device, vid
        ports = [P('/dev/cu.Bluetooth', None), P('/dev/cu.usbserial', 0x0403), P('/dev/cu.usbmodem1101', 0x303A)]
        self.assertEqual(device.find_port(ports), '/dev/cu.usbmodem1101')
        self.assertIsNone(device.find_port(ports[:2]))

    def test_link_request_waits_for_consent_on_the_device(self):
        port = FakePort()
        said = []
        info = device.request_link(port, said.append, timeout=5)
        self.assertEqual(info['usb_window_s'], 120)
        self.assertTrue(port.link_requests >= 1, 'the device is asked before any data is sent')

    def test_advertised_ble_uuid_matches_qr_uuid(self):
        source = (ROOT / 'main/agent_pet_provisioning.c').read_text()
        text = re.search(r'service_uuid\[\]\s*=\s*"([^"]+)"', source)
        array = re.search(r'ble_service_uuid\[16\]\s*=\s*\{([^}]+)\}', source)
        self.assertIsNotNone(text)
        self.assertIsNotNone(array)
        advertised = bytes(int(value, 16) for value in re.findall(r'0x([0-9a-fA-F]{2})', array.group(1)))
        self.assertEqual(advertised, uuid.UUID(text.group(1)).bytes[::-1])
        self.assertIn('wifi_prov_scheme_ble_set_service_uuid(ble_service_uuid)', source)

    def test_fragmented_serial_with_oversize_log_recovers_at_next_line(self):
        parser = device.Lines()
        self.assertEqual(parser.feed(b'x' * 4000), [])
        self.assertEqual(parser.feed(b'x' * 200 + b'\n{"v":'), [])
        self.assertEqual(parser.feed(b'1}\r\n'), [b'{"v":1}'])

    def test_exact_bound_is_preserved(self):
        parser = device.Lines()
        frame = b'x' * device.FRAME_MAX
        self.assertEqual(parser.feed(frame + b'\n'), [frame])

    def test_info_filters_unexpected_and_secret_fields(self):
        source = {'v': 1, 'type': 'device.info', 'payload': {
            'device_id': 'passport-1', 'view_epoch': 'temporary-epoch',
            'public_mode': True, 'token': 'must-not-escape', 'ssid': 'private-network',
            'task_count': 2}}
        result = device.info_reply(json.dumps(source).encode())
        self.assertEqual(result['task_count'], 2)
        self.assertNotIn('token', result)
        self.assertNotIn('ssid', result)
        self.assertIsNone(device.info_reply(b'boot log is not JSON'))
        self.assertIsNone(device.info_reply(b'{"v":1,"type":"setup","payload":{}}'))

    @unittest.skipUnless((ROOT / 'services/node_modules/ws/package.json').exists(), 'Run npm ci in services')
    def test_usb_bridge_refuses_unencrypted_endpoint_without_printing_token(self):
        token = 'x' * 43
        configuration = {'url': 'ws://127.0.0.1:1/v1/device', 'credential': token}
        result = subprocess.run(['node', str(ROOT / 'tools/agent_pet_usb_bridge.mjs')],
                                input=json.dumps(configuration) + '\n', text=True,
                                capture_output=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(token, result.stdout + result.stderr)
        self.assertIn('Invalid bridge configuration', result.stderr)


if __name__ == '__main__':
    unittest.main()
