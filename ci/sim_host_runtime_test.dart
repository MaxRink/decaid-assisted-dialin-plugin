// E64 WS simulator -> E64 plugin -> Decaid grinder observation -> assisted dial-in,
// all inside the real Decaid QuickJS host: PluginManager, PluginDeviceService,
// GrinderController and the real /api/v1/grinder REST handler. Only the
// workflow and shot-history routes are fixtures.
//
// The E64 plugin connects as it would to a grinder: WSS with a pinned
// self-signed certificate (certSha256) and a token minted through the
// simulator's REST login (restPort + password). Host-side pinning needs a
// Decaid build with tlsPinSha256 support.
//
// Copied temporarily into a Decaid checkout's test/plugins/ by
// scripts/run-sim-host-test.sh. Needs DIALIN_PLUGIN_ROOT, E64_PLUGIN_ROOT and
// E64_SIM_ROOT (the private research repository; nothing from it is copied
// here). A missing simulator fails unless E64_SIM_OPTIONAL=1.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:reaprime/src/controllers/grinder_controller.dart';
import 'package:reaprime/src/models/device/grinder_device.dart';
import 'package:reaprime/src/plugins/plugin_device_service.dart';
import 'package:reaprime/src/plugins/plugin_grinder.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';
import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'package:reaprime/src/services/storage/kv_store_service.dart';
import 'package:reaprime/src/services/webserver_service.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:shelf_plus/shelf_plus.dart';

// Self-contained: Decaid checkouts ship their own test helpers.
class MemoryStore implements KeyValueStoreService {
  final Map<String, Map<String, Object>> values = {};
  @override
  Future<void> initialize() async {}
  @override
  Future<Object?> get({String namespace = 'default', required String key}) async => values[namespace]?[key];
  @override
  Future<void> set({String namespace = 'default', required String key, required Object value}) async =>
      values.putIfAbsent(namespace, () => {})[key] = value;
  @override
  Future<bool> delete({String namespace = 'default', required String key}) async => values[namespace]?.remove(key) != null;
  @override
  Future<List<String>> keys({String namespace = 'default'}) async => values[namespace]?.keys.toList() ?? [];
  @override
  List<String> get namespaces => values.keys.toList();
  @override
  Future<Map<String, Object>> getAll({String namespace = 'default'}) async => Map.of(values[namespace] ?? {});
}

Future<int> freePort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

Map<String, dynamic> workflow() => {
  'profile': {
    'title': 'espresso',
    'steps': [
      {'name': 'Extraction', 'pump': 'pressure', 'pressure': 9, 'seconds': 30},
    ],
  },
  'context': {
    'beanBatchId': 'batch-sim',
    'grinderId': 'grinder-sim',
    'grinderModel': 'E64 WS',
    'grinderBurrs': 'stock',
    'targetDoseWeight': 18.0,
    'targetYield': 36.0,
    'extras': {
      'calibrationEpoch': 'epoch-1',
      'basket': '58mm',
      'grinderSettingUnit': 'deci-micrometre',
    },
  },
};

final env = Platform.environment;
final dialinRoot = env['DIALIN_PLUGIN_ROOT'] ?? '.';
final simRoot = env['E64_SIM_ROOT'] ?? '$dialinRoot/../mahlkoenig-e64ws-local-research';
final e64Root = env['E64_PLUGIN_ROOT'] ?? '$dialinRoot/../decaid-e64ws-plugin';
final simScript = '$simRoot/tools/e64ws_simulator.py';
final replayFixture = '$simRoot/tests/fixtures/grind-20261119-01.sanitized.jsonl';

/// One running chain: simulator, E64 plugin, grinder controller, Decaid REST
/// on 127.0.0.1:8080 and the assisted dial-in plugin.
class Chain {
  Chain._(this.simControl, this.store, this.manager, this.grinders, this.current, this.shots, this.dialinId, this.e64Id, this.e64DeviceId);

  final Future<void> Function(String route, Map<String, dynamic> body) simControl;
  final MemoryStore store;
  final PluginManager manager;
  final GrinderController grinders;
  final Map<String, dynamic> current;
  final List<Map<String, dynamic>> shots;
  final String dialinId, e64Id, e64DeviceId;
  var _sequence = 0;

  static Future<Chain> start({List<String> simArgs = const []}) async {
    // 1. A self-signed certificate for the simulator's WSS and REST listeners.
    final temp = await Directory.systemTemp.createTemp('dialin-e64-sim-');
    addTearDown(() => temp.delete(recursive: true));
    final cert = '${temp.path}/cert.pem', key = '${temp.path}/key.pem';
    final made = await Process.run('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-nodes', '-days', '2', '-subj', '/CN=e64-sim', '-keyout', key, '-out', cert,
    ]);
    expect(made.exitCode, 0, reason: '${made.stderr}');
    final fingerprint = await Process.run('openssl', ['x509', '-noout', '-fingerprint', '-sha256', '-in', cert]);
    final pin = (fingerprint.stdout as String).trim().split('=').last;

    // 2. The simulator.
    final wsPort = await freePort(), httpPort = await freePort();
    final python = env['E64_SIM_PYTHON'] ??
        (File('$simRoot/.venv/bin/python').existsSync() ? '$simRoot/.venv/bin/python' : 'python3');
    final sim = await Process.start(python, [
      '-u', simScript, '--host', '127.0.0.1', '--port', '$wsPort', '--http-port', '$httpPort',
      '--scale-port', '${await freePort()}', '--token', 'host-sim-token',
      '--tls-cert', cert, '--tls-key', key, '--http-tls-cert', cert, '--http-tls-key', key,
      ...simArgs,
    ], workingDirectory: simRoot);
    final output = StringBuffer();
    sim.stdout.transform(utf8.decoder).listen(output.write);
    sim.stderr.transform(utf8.decoder).listen(output.write);
    addTearDown(() async {
      sim.kill();
      await sim.exitCode;
    });
    final ready = DateTime.now().add(const Duration(seconds: 15));
    while (!output.toString().contains('E64 simulator:')) {
      expect(DateTime.now().isBefore(ready), isTrue, reason: 'simulator did not start: $output');
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    final control = HttpClient()..badCertificateCallback = (_, _, _) => true;
    addTearDown(() => control.close(force: true));
    Future<void> simControl(String route, Map<String, dynamic> body) async {
      final request = await control.postUrl(Uri.parse('https://127.0.0.1:$httpPort$route'));
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode(body));
      final response = await request.close();
      await response.drain<void>();
      expect(response.statusCode, 200, reason: route);
    }

    // 3. The real host: the E64 plugin pins the certificate and mints a token
    //    through the simulator's REST login, then registers a grinder.
    final store = MemoryStore();
    final service = PluginDeviceService();
    final manager = PluginManager(kvStore: store, deviceService: service, deviceInvocationTimeout: const Duration(seconds: 10));
    final grinders = GrinderController();
    addTearDown(() async {
      await manager.dispose();
      await grinders.dispose();
      await service.dispose();
    });
    final e64Manifest = PluginManifest.fromJson(
      jsonDecode(await File('$e64Root/manifest.json').readAsString()) as Map<String, dynamic>,
    );
    await manager.loadPlugin(
      id: e64Manifest.id,
      manifest: e64Manifest,
      settings: {
        'InstancesJson': jsonEncode([
          {'id': 'sim', 'name': 'E64 WS simulator', 'scheme': 'wss', 'host': '127.0.0.1', 'port': wsPort,
            'restPort': httpPort, 'certSha256': pin, 'pollMs': 100},
        ]),
        'TokensJson': '{}',
        'MintTokens': 'true',
        'PasswordsJson': jsonEncode({'sim': {'host': '127.0.0.1', 'password': 'sim-password'}}),
      },
      jsCode: await File('$e64Root/plugin.js').readAsString(),
    );
    final device = (await service.devices.where((devices) => devices.length == 1).first.timeout(const Duration(seconds: 5)))
        .cast<PluginGrinder>()
        .single;
    await grinders.connectToGrinder(device);

    // 4. Decaid's REST API on the plugin's loopback port: the real grinder
    //    handler, plus fixed workflow/shot routes.
    final current = workflow();
    final shots = <Map<String, dynamic>>[];
    final router = Router().plus;
    GrinderHandler(controller: grinders).addRoutes(router);
    Response jsonResponse(Object? body, [int status = 200]) =>
        Response(status, body: jsonEncode(body), headers: {'content-type': 'application/json'});
    router.get('/api/v1/workflow', (Request _) => jsonResponse(current));
    router.get('/api/v1/shots', (Request _) => jsonResponse({'items': shots, 'total': shots.length}));
    router.get('/api/v1/shots/<id>', (Request _, String id) {
      final match = shots.where((shot) => shot['id'] == id);
      return match.isEmpty ? jsonResponse({'error': 'No such shot'}, 404) : jsonResponse(match.first);
    });
    final HttpServer api;
    try {
      api = await shelf_io.serve(router.call, '127.0.0.1', 8080);
    } on SocketException catch (error) {
      fail('the assisted dial-in plugin calls Decaid on 127.0.0.1:8080, which is in use: $error');
    }
    addTearDown(() => api.close(force: true));

    // 5. The assisted dial-in plugin, unmodified, in the same host.
    final dialinManifest = PluginManifest.fromJson(
      jsonDecode(await File('$dialinRoot/manifest.json').readAsString()) as Map<String, dynamic>,
    );
    await manager.loadPlugin(
      id: dialinManifest.id,
      manifest: dialinManifest,
      settings: const {'TargetTimeSec': 28},
      jsCode: await File('$dialinRoot/plugin.js').readAsString(),
    );
    return Chain._(simControl, store, manager, grinders, current, shots, dialinManifest.id, e64Manifest.id, device.deviceId);
  }

  Future<void> observed(bool Function(GrinderSnapshot snapshot) test) =>
      grinders.snapshots.firstWhere(test).timeout(const Duration(seconds: 10));

  Future<Map<String, dynamic>> call(String endpoint, {String method = 'GET', Object? body, String? plugin, Map<String, String> query = const {}}) async {
    final id = 'sim-${++_sequence}';
    final target = plugin ?? dialinId;
    final pending = manager.registerPendingHttp(target, id);
    manager.dispatchEvent(target, 'httpRequest', {
      'requestId': id, 'endpoint': endpoint, 'method': method, 'headers': <String, String>{},
      'body': body, 'query': query,
    });
    final response = await pending.timeout(const Duration(seconds: 10));
    expect(response['status'], 200, reason: '$endpoint: ${response['body']}');
    return jsonDecode(response['body'] as String) as Map<String, dynamic>;
  }

  /// Stores a shot now (as Decaid would) and waits for its recorded dial.
  Future<int> storeShot(String id) async {
    shots.add({
      'id': id,
      'timestamp': DateTime.now().toUtc().subtract(const Duration(seconds: 30)).toIso8601String(),
      'workflow': workflow(),
      'measurements': <dynamic>[],
    });
    manager.dispatchEvent(dialinId, 'shotStored', {'id': id});
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (true) {
      final saved = store.values[dialinId]?['grinderObservations.v1'];
      final recorded = saved is Map ? saved['shots'] : null;
      final entry = recorded is Map ? recorded[id] : null;
      if (entry is Map) return entry['ddValueDum'] as int;
      expect(DateTime.now().isBefore(deadline), isTrue, reason: 'no live dial was recorded for $id');
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
  }
}

void main() {
  final missing = [
    if (!File(simScript).existsSync()) 'E64 simulator not found at $simScript (set E64_SIM_ROOT)',
    if (!File('$e64Root/plugin.js').existsSync()) 'E64 plugin not found in $e64Root (set E64_PLUGIN_ROOT)',
  ];
  final skip = missing.isNotEmpty && env['E64_SIM_OPTIONAL'] == '1'
      ? 'E64 simulator unavailable (E64_SIM_OPTIONAL=1): ${missing.join('; ')}'
      : null;

  test(
    'simulated E64 dial reaches assisted dial-in suggestions and shot records through the Decaid host',
    () async {
      expect(missing, isEmpty, reason: missing.join('; '));
      final chain = await Chain.start();
      // The E64 plugin logged in through the simulator's REST API over pinned TLS.
      await chain.observed((snapshot) => snapshot.observedSetting != null);
      final connection = await chain.call('e64-diagnostics', plugin: chain.e64Id,
          query: {'deviceId': chain.e64DeviceId, 'read': 'connection'});
      expect(connection['tokenSource'], 'password');

      await chain.simControl('/sim/action', {'suffix': 'SetAgsaTargetDdValue', 'data': {'targetDdValue': 630}});
      await chain.observed((snapshot) => snapshot.observedSetting == '630 ddValueDum');
      final observation = await chain.call('grinder-observation');
      expect(observation['setting'], '630 ddValueDum');
      expect(observation['coordinate'], {'value': 630, 'unit': 'deci-micrometre'});
      expect(observation['observedAt'], isNotNull);
      expect((observation['surfaces'] as List).single['href'],
          allOf(startsWith('/api/v1/plugins/mahlkoenig-e64.reaplugin/e64-diagnostics?'), contains('deviceId=plugin%3Amahlkoenig-e64.reaplugin')));

      var suggestion = await chain.call('suggestion');
      expect(suggestion['currentSettingSource'], 'live-grinder-observation');
      expect((suggestion['dialReference'] as Map)['currentNative']['value'], 63);
      expect(suggestion['missingData'] ?? const [], isNot(contains('grinderSetting')));

      await chain.simControl('/sim/action', {'suffix': 'SetAgsaTargetDdValue', 'data': {'targetDdValue': 700}});
      await chain.observed((snapshot) => snapshot.observedSetting == '700 ddValueDum');
      suggestion = await chain.call('suggestion');
      expect((suggestion['dialReference'] as Map)['currentNative']['value'], 70);

      // A shot stored now keeps the dial the simulator reported for it.
      expect(await chain.storeShot('sim-shot'), 700);
      await chain.simControl('/sim/action', {'suffix': 'SetAgsaTargetDdValue', 'data': {'targetDdValue': 900}});
      await chain.observed((snapshot) => snapshot.observedSetting == '900 ddValueDum');
      final analysis = await chain.call('analysis', method: 'POST', body: {'shotId': 'sim-shot'});
      expect(analysis['context']['grinderSetting'], '700');
      expect(analysis['context']['grinderSettingSource'], 'recorded-live-observation');

      // A grind started on the simulator shows as the live grinder state.
      await chain.simControl('/sim/action', {'suffix': 'StartGrindManual', 'data': {}});
      await chain.observed((snapshot) => snapshot.state == GrinderState.grinding);
      expect((await chain.call('grinder-observation'))['grinderState'], 'grinding');
      await chain.simControl('/sim/action', {'suffix': 'Stop', 'data': {}});

      // The workflow's own recorded setting still wins over the live dial.
      (chain.current['context'] as Map)['grinderSetting'] = '640';
      suggestion = await chain.call('suggestion');
      expect(suggestion['currentSettingSource'], 'workflow');
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test(
    'the replayed 2026-11-19 grind drives the live grinder state and the dial recorded with its shot',
    () async {
      expect(missing, isEmpty, reason: missing.join('; '));
      expect(File(replayFixture).existsSync(), isTrue, reason: 'replay fixture not found at $replayFixture');
      final chain = await Chain.start(simArgs: ['--replay', replayFixture]);

      // Before the grind: idle at the captured dial.
      await chain.observed((snapshot) => snapshot.observedSetting == '819 ddValueDum' && snapshot.state == GrinderState.idle);
      var observation = await chain.call('grinder-observation');
      expect(observation['grinderState'], 'idle');
      expect(observation['coordinate'], {'value': 819, 'unit': 'deci-micrometre'});

      // During the captured Grind phase.
      await chain.simControl('/sim/replay/seek', {'t': 30.0});
      await chain.observed((snapshot) => snapshot.state == GrinderState.grinding);
      observation = await chain.call('grinder-observation');
      expect(observation['grinderState'], 'grinding');
      expect(observation['setting'], '819 ddValueDum');
      expect((await chain.call('suggestion'))['currentSettingSource'], 'live-grinder-observation');

      // After the grind (GbwPostGrind, then Idle) the shot is stored and keeps the replayed dial.
      await chain.simControl('/sim/replay/seek', {'t': 36.0});
      await chain.observed((snapshot) => snapshot.state == GrinderState.idle);
      expect(await chain.storeShot('replayed-shot'), 819);
      final analysis = await chain.call('analysis', method: 'POST', body: {'shotId': 'replayed-shot'});
      expect(analysis['context']['grinderSetting'], '819');
      expect(analysis['context']['grinderSettingSource'], 'recorded-live-observation');
      expect((analysis['recordedGrinderObservation'] as Map)['ddValueDum'], 819);
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
