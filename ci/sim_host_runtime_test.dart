// E64 WS simulator -> E64 plugin -> Decaid grinder observation -> assisted dial-in,
// all inside the real Decaid QuickJS host: PluginManager, PluginDeviceService,
// GrinderController, the real /api/v1/grinder REST handler and the real
// /api/v1/grinders inventory handler over an in-memory store. The workflow
// route deep-merges like PUT /api/v1/workflow; shot history is a fixture.
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
import 'package:reaprime/src/models/data/grinder.dart';
import 'package:reaprime/src/models/data/json_utils.dart';
import 'package:reaprime/src/models/data/workflow_context.dart';
import 'package:reaprime/src/models/device/grinder_device.dart';
import 'package:reaprime/src/plugins/plugin_device_service.dart';
import 'package:reaprime/src/plugins/plugin_grinder.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';
import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'package:reaprime/src/services/storage/grinder_storage_service.dart';
import 'package:reaprime/src/services/storage/kv_store_service.dart';
import 'package:reaprime/src/services/webserver/grinders_handler.dart';
import 'package:reaprime/src/services/webserver_service.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:shelf_plus/shelf_plus.dart';

// The E64 repository's simulator launcher (ci/host_sim_test.dart), copied next
// to this file by scripts/run-sim-host-test.sh so both repositories start the
// simulator the same way.
import 'dialin_e64_sim_helper.dart' show E64Sim;

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

// Decaid's grinder inventory, in memory, behind the real GrindersHandler.
class MemoryGrinders implements GrinderStorageService {
  final records = <Grinder>[];
  @override
  Future<List<Grinder>> getAllGrinders({bool includeArchived = false}) async =>
      records.where((g) => includeArchived || !g.archived).toList();
  @override
  Stream<List<Grinder>> watchAllGrinders({bool includeArchived = false}) => throw UnimplementedError();
  @override
  Future<Grinder?> getGrinderById(String id) async => records.where((g) => g.id == id).firstOrNull;
  @override
  Future<void> insertGrinder(Grinder grinder) async => records.add(grinder);
  @override
  Future<void> updateGrinder(Grinder grinder) async {
    records.removeWhere((g) => g.id == grinder.id);
    records.add(grinder);
  }
  @override
  Future<void> deleteGrinder(String id) async => records.removeWhere((g) => g.id == id);
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
  Chain._(this.simControl, this.simRequest, this.store, this.manager, this.grinders, this.inventory, this.current, this.shots, this.dialinId, this.e64Id,
      this.e64DeviceId);

  final Future<void> Function(String route, Map<String, dynamic> body) simControl;
  final Future<Map<String, dynamic>> Function(String route, [Map<String, dynamic>? body]) simRequest;
  final MemoryStore store;
  final PluginManager manager;
  final GrinderController grinders;
  final MemoryGrinders inventory;
  final Map<String, dynamic> current;
  final List<Map<String, dynamic>> shots;
  final String dialinId, e64Id, e64DeviceId;
  var _sequence = 0;

  /// [replay] runs the simulator replaying a grind capture (`--replay`).
  static Future<Chain> start({String? replay, bool control = false, String owner = 'off',
      Map<String, dynamic> dialinSettings = const {'TargetTimeSec': 28}, Map<String, dynamic>? currentWorkflow,
      Map<String, Object> dialinStorage = const {}}) async {
    // The E64 repository's launcher: fresh certificate, pinned WSS and REST login.
    final sim = await E64Sim.start(simRoot, extraArgs: [if (replay != null) ...['--replay', replay]]);
    addTearDown(sim.stop);
    final simRequest = sim.control;
    final e64Settings = Map<String, dynamic>.of(sim.settings(control: control, owner: owner));
    Future<void> simControl(String route, Map<String, dynamic> body) async => simRequest(route, body);

    // 3. The real host. The E64 plugin pins the certificate and mints a token
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
    // 4. Decaid's REST API on the plugins' loopback port: the real grinder and
    //    grinder-inventory handlers, plus workflow/shot routes. It is up before
    //    the E64 plugin connects, which is when it syncs its inventory record.
    final current = currentWorkflow ?? workflow();
    final shots = <Map<String, dynamic>>[];
    final router = Router().plus;
    GrinderHandler(controller: grinders).addRoutes(router);
    final inventory = MemoryGrinders();
    GrindersHandler(storage: inventory).addRoutes(router);
    Response jsonResponse(Object? body, [int status = 200]) =>
        Response(status, body: jsonEncode(body), headers: {'content-type': 'application/json'});
    router.get('/api/v1/workflow', (Request _) => jsonResponse(current));
    router.put('/api/v1/workflow', (Request request) async {
      final patch = jsonDecode(await request.readAsString()) as Map<String, dynamic>;
      // The host's own merge; its context model must accept the result.
      final merged = deepMergeJson(current, patch);
      WorkflowContext.fromJson(merged['context'] as Map<String, dynamic>);
      current..clear()..addAll(merged);
      return jsonResponse(current);
    });
    router.get('/api/v1/shots', (Request _) => jsonResponse({'items': shots, 'total': shots.length}));
    router.get('/api/v1/shots/<id>', (Request _, String id) {
      final match = shots.where((shot) => shot['id'] == id);
      return match.isEmpty ? jsonResponse({'error': 'No such shot'}, 404) : jsonResponse(match.first);
    });
    router.get('/api/v1/bean-batches/<id>', (Request _, String id) => jsonResponse({'id': id, 'beanId': 'bean-sim'}));
    router.get('/api/v1/beans/<id>', (Request _, String id) => jsonResponse({'id': id, 'name': 'Simulator beans'}));
    // Decaid's plugin routes, as far as assisted dial-in reads them: stored
    // non-secure settings and read-only plugin endpoints (GET only).
    router.get('/api/v1/plugins/<id>/settings', (Request _, String id) => id == e64Manifest.id
        ? jsonResponse({'AdjustmentOwner': e64Settings['AdjustmentOwner']}) : jsonResponse({'error': 'not found'}, 404));
    var routed = 0;
    router.get('/api/v1/plugins/<id>/<endpoint>', (Request request, String id, String endpoint) async {
      final requestId = 'route-${++routed}';
      final pending = manager.registerPendingHttp(id, requestId);
      manager.dispatchEvent(id, 'httpRequest', {'requestId': requestId, 'endpoint': endpoint, 'method': 'GET',
        'headers': <String, String>{}, 'body': null, 'query': request.url.queryParameters});
      final response = await pending.timeout(const Duration(seconds: 10));
      return Response(response['status'] as int? ?? 200, body: response['body'] as String?, headers: {'content-type': 'application/json'});
    });
    final HttpServer api;
    try {
      api = await shelf_io.serve(router.call, '127.0.0.1', 8080);
    } on SocketException catch (error) {
      fail('the assisted dial-in plugin calls Decaid on 127.0.0.1:8080, which is in use: $error');
    }
    addTearDown(() => api.close(force: true));

    await manager.loadPlugin(
      id: e64Manifest.id,
      manifest: e64Manifest,
      settings: e64Settings,
      jsCode: await File('$e64Root/plugin.js').readAsString(),
    );
    final device = (await service.devices.where((devices) => devices.length == 1).first.timeout(const Duration(seconds: 5)))
        .cast<PluginGrinder>()
        .single;
    await grinders.connectToGrinder(device);

    // 5. The assisted dial-in plugin, unmodified, in the same host.
    final dialinManifest = PluginManifest.fromJson(
      jsonDecode(await File('$dialinRoot/manifest.json').readAsString()) as Map<String, dynamic>,
    );
    if (dialinStorage.isNotEmpty) store.values[dialinManifest.id] = Map.of(dialinStorage);
    await manager.loadPlugin(
      id: dialinManifest.id,
      manifest: dialinManifest,
      settings: dialinSettings,
      jsCode: await File('$dialinRoot/plugin.js').readAsString(),
    );
    return Chain._(simControl, simRequest, store, manager, grinders, inventory, current, shots, dialinManifest.id, e64Manifest.id, device.deviceId);
  }

  Future<void> observed(bool Function(GrinderSnapshot snapshot) test) =>
      grinders.snapshots.firstWhere(test).timeout(const Duration(seconds: 10));

  Future<Map<String, dynamic>> call(String endpoint, {String method = 'GET', Object? body, String? plugin, Map<String, String> query = const {},
      Map<String, String> headers = const {}, int expectStatus = 200}) async {
    final id = 'sim-${++_sequence}';
    final target = plugin ?? dialinId;
    final pending = manager.registerPendingHttp(target, id);
    manager.dispatchEvent(target, 'httpRequest', {
      'requestId': id, 'endpoint': endpoint, 'method': method, 'headers': headers,
      'body': body, 'query': query,
    });
    final response = await pending.timeout(const Duration(seconds: 10));
    expect(response['status'], expectStatus, reason: '$endpoint: ${response['body']}');
    return jsonDecode(response['body'] as String) as Map<String, dynamic>;
  }

  /// Stores a shot now (as Decaid would) and waits for its recorded dial.
  Future<Map> storeShot(String id) async {
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
      if (entry is Map) return entry;
      expect(DateTime.now().isBefore(deadline), isTrue, reason: 'no live dial was recorded for $id');
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
  }
}

// A current workflow in the grinder's display unit (micrometres), and three
// comparable sour shots at display 500: one 5 µm step finer suggests 495.
Map<String, dynamic> micronWorkflow({String? setting}) {
  final value = workflow();
  final context = value['context'] as Map<String, dynamic>;
  (context['extras'] as Map<String, dynamic>)['grinderSettingUnit'] = 'micrometres';
  if (setting != null) context['grinderSetting'] = setting;
  return value;
}
const stepSettings = {'TargetTimeSec': 28, 'StepSize': 5, 'NumericFinerDelta': -1};
const page = {'origin': 'http://127.0.0.1:8080', 'host': '127.0.0.1:8080'};
Future<void> sourShotsAt500(Chain chain) async {
  for (var hour = 1; hour <= 3; hour++) {
    final id = 'evidence-$hour';
    chain.shots.add({'id': id, 'timestamp': DateTime.now().toUtc().subtract(Duration(hours: hour)).toIso8601String(),
      'workflow': micronWorkflow(setting: '500'), 'measurements': <dynamic>[]});
    await chain.call('feedback', method: 'POST',
        body: {'shotId': id, 'good': false, 'taste': 'sour', 'brewTimeSec': 22, 'brewTimeClock': 'pump'});
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

      // E64 plugin 0.4.4 publishes the grinder's display value: dD 630 shows as 63 (µm).
      await chain.simControl('/sim/action', {'suffix': 'SetAgsaTargetDdValue', 'data': {'targetDdValue': 630}});
      await chain.observed((snapshot) => snapshot.observedSetting == '63');
      final observation = await chain.call('grinder-observation');
      expect(observation['setting'], '63');
      expect(observation['reading'], {'kind': 'display', 'value': 63});
      expect(observation['coordinate'], isNull, reason: 'a rounded display claims no exact dD');
      expect(observation['observedAt'], isNotNull);
      expect((observation['surfaces'] as List).single['href'],
          allOf(startsWith('/api/v1/plugins/mahlkoenig-e64.reaplugin/e64-diagnostics?'), contains('deviceId=plugin%3Amahlkoenig-e64.reaplugin')));

      var suggestion = await chain.call('suggestion');
      expect(suggestion['currentSettingSource'], 'live-grinder-observation');
      expect((suggestion['dialReference'] as Map)['currentNative']['value'], 63);
      expect(suggestion['currentSettingPrecisionDd'], 5);
      expect(suggestion['missingData'] ?? const [], isNot(contains('grinderSetting')));

      await chain.simControl('/sim/action', {'suffix': 'SetAgsaTargetDdValue', 'data': {'targetDdValue': 700}});
      await chain.observed((snapshot) => snapshot.observedSetting == '70');
      suggestion = await chain.call('suggestion');
      expect((suggestion['dialReference'] as Map)['currentNative']['value'], 70);

      // A shot stored now keeps the dial the simulator reported for it.
      expect((await chain.storeShot('sim-shot'))['display'], 70);
      await chain.simControl('/sim/action', {'suffix': 'SetAgsaTargetDdValue', 'data': {'targetDdValue': 900}});
      await chain.observed((snapshot) => snapshot.observedSetting == '90');
      final analysis = await chain.call('analysis', method: 'POST', body: {'shotId': 'sim-shot'});
      // The shot's workflow uses dD: display 70 µm is 700 dD, known to ±5.
      expect(analysis['context']['grinderSetting'], '700');
      expect(analysis['context']['grinderSettingPrecisionDd'], 5);
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
    'owner decaid: a confirmed suggestion is applied through Decaid\'s setting route and moves the simulated dial',
    () async {
      expect(missing, isEmpty, reason: missing.join('; '));
      final chain = await Chain.start(control: true, owner: 'decaid', dialinSettings: stepSettings, currentWorkflow: micronWorkflow());
      expect(chain.e64DeviceId, 'plugin:mahlkoenig-e64.reaplugin:e64-control:sim');
      await chain.observed((snapshot) => snapshot.observedSetting == '500');
      await sourShotsAt500(chain);
      final suggestion = await chain.call('suggestion');
      expect(suggestion['currentSettingSource'], 'live-grinder-observation');
      expect(suggestion['proposedSetting'], 495);
      expect(suggestion['settingUnit'], 'micrometres');
      final control = await chain.call('grinder-control');
      expect(control['owner'], 'decaid');
      expect(control['applyAvailable'], isTrue);
      final request = {'proposedSetting': 495, 'settingUnit': 'micrometres'};
      await chain.call('apply-setting', method: 'POST', body: request, headers: page, expectStatus: 409);
      await chain.call('apply-setting', method: 'POST', body: {...request, 'confirmed': true}, expectStatus: 403);
      expect(((await chain.simRequest('/sim/state'))['grinder'] as Map)['ddValueDum'], 5000, reason: 'nothing moves without confirmation from the page');
      final applied = await chain.call('apply-setting', method: 'POST', body: {...request, 'confirmed': true}, headers: page);
      expect(applied['setting'], '495');
      await chain.observed((snapshot) => snapshot.observedSetting == '495');
      expect(((await chain.simRequest('/sim/state'))['grinder'] as Map)['ddValueDum'], 4950);
      final shots = (chain.store.values[chain.dialinId]!['grinderObservations.v1'] as Map)['shots'] as Map;
      final record = (shots[(suggestion['sourceShotIds'] as List).first] as Map)['applied'] as Map;
      expect(record['suggested'], {'value': 495, 'unit': 'micrometres'});
      expect(record['applied'], {'value': 495, 'unit': 'grinder display'});
      expect(record['accepted'], isTrue);
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test(
    'owner grinder: the assisted suggestion is recorded and compared with the dial the grinder moves to',
    () async {
      expect(missing, isEmpty, reason: missing.join('; '));
      final chain = await Chain.start(owner: 'grinder', dialinSettings: stepSettings, currentWorkflow: micronWorkflow());
      await chain.observed((snapshot) => snapshot.observedSetting == '500');
      await sourShotsAt500(chain);
      expect((await chain.call('grinder-control'))['applyAvailable'], isFalse);
      final first = await chain.storeShot('shadow-1');
      expect(first['display'], 500);
      expect((first['shadow'] as Map)['proposedSetting'], 495);
      expect((first['shadow'] as Map)['direction'], 'finer');
      // The grinder's own GBS moves the dial before the next shot.
      await chain.simControl('/sim/action', {'suffix': 'SetAgsaTargetDdValue', 'data': {'targetDdValue': 4980}});
      await chain.observed((snapshot) => snapshot.observedSetting == '498');
      await chain.storeShot('shadow-2');
      final rows = (await chain.call('gbs-comparison'))['rows'] as List;
      final row = rows.cast<Map>().firstWhere((item) => item['shotId'] == 'shadow-1');
      expect(row['dial'], {'value': 500, 'unit': 'grinder display'});
      expect(row['grinderNext'], {'shotId': 'shadow-2', 'dial': {'value': 498, 'unit': 'grinder display'}, 'direction': 'smaller'});
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test(
    'the replayed 2026-11-19 grind drives the live grinder state and the dial recorded with its shot',
    () async {
      expect(missing, isEmpty, reason: missing.join('; '));
      expect(File(replayFixture).existsSync(), isTrue, reason: 'replay fixture not found at $replayFixture');
      final chain = await Chain.start(replay: replayFixture);

      // Before the grind: idle at the captured dial, dD 819, which the E64 shows as 82.
      await chain.observed((snapshot) => snapshot.observedSetting == '82' && snapshot.state == GrinderState.idle);
      var observation = await chain.call('grinder-observation');
      expect(observation['grinderState'], 'idle');
      expect(observation['reading'], {'kind': 'display', 'value': 82});

      // During the captured Grind phase.
      await chain.simControl('/sim/replay/seek', {'t': 30.0});
      await chain.observed((snapshot) => snapshot.state == GrinderState.grinding);
      observation = await chain.call('grinder-observation');
      expect(observation['grinderState'], 'grinding');
      expect(observation['setting'], '82');
      expect((await chain.call('suggestion'))['currentSettingSource'], 'live-grinder-observation');

      // After the grind (GbwPostGrind, then Idle) the shot is stored and keeps the replayed dial.
      await chain.simControl('/sim/replay/seek', {'t': 36.0});
      await chain.observed((snapshot) => snapshot.state == GrinderState.idle);
      final record = await chain.storeShot('replayed-shot');
      expect(record['display'], 82);
      // The E64 plugin reported the replayed grind; it is linked to the shot that followed it.
      final linked = Map<String, dynamic>.from(record['grind'] as Map);
      expect(linked['completedAt'], isNotNull);
      // After the grind the E64 plugin downloads the grinder's own grind log, if
      // the host's fetch can return binary data. Wait for that to settle.
      Future<String?> logStatus() async =>
          ((await chain.call('grind-events', plugin: chain.e64Id, query: {'deviceId': chain.e64DeviceId}))['log'] as Map?)?['status'] as String?;
      var status = await logStatus();
      final settled = DateTime.now().add(const Duration(seconds: 20));
      while (!['ok', 'unsupported-host', 'failed'].contains(status) && DateTime.now().isBefore(settled)) {
        await Future<void>.delayed(const Duration(milliseconds: 200));
        status = await logStatus();
      }
      late Map grind;
      if (status == 'unsupported-host') {
        // Older hosts cannot return the log ZIP: only the live grind values exist.
        grind = linked;
        expect(grind['grindUuid'], isNull);
        expect(grind['weightG'], 18.085);
        expect(grind['durationS'], 7.554);
        expect(grind['targets'], {'targetWeightG': 18});
        expect((grind['recipe'] as Map).values.every((value) => value == null), isTrue);
      } else {
        // The log arrives after the shot was linked; reading the shot refreshes
        // the same grind (same completion time) with its UUID, recipe and logged values.
        expect(status, 'ok', reason: 'E64 grind log status');
        var refreshed = linked;
        final deadline = DateTime.now().add(const Duration(seconds: 20));
        while (refreshed['grindUuid'] == null && DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 200));
          refreshed = Map<String, dynamic>.from((await chain.call('analysis', method: 'POST', body: {'shotId': 'replayed-shot'}))['grind'] as Map);
        }
        grind = refreshed;
        expect(grind['grindUuid'], isNotNull, reason: 'the grind log never reached the linked shot');
        expect(grind['completedAt'], linked['completedAt'], reason: 'the refresh keeps the same grind');
        final recipe = grind['recipe'] as Map;
        expect(recipe['uuid'], isNotNull);
        expect(recipe['mode'], isNotNull);
        expect(recipe['amount'], isNotNull);
        expect((grind['targets'] as Map)['targetWeightG'], 18);
        expect(grind['weightG'], isNotNull);
        final stored = (chain.store.values[chain.dialinId]!['grinderObservations.v1'] as Map)['shots'] as Map;
        expect(((stored['replayed-shot'] as Map)['grind'] as Map)['grindUuid'], grind['grindUuid'], reason: 'the refresh is stored');
      }
      // ignore: avoid_print
      print('replayed grind: E64 grind log $status, recipe ${grind['grindUuid'] == null ? 'not available' : grind['recipe']}');
      final analysis = await chain.call('analysis', method: 'POST', body: {'shotId': 'replayed-shot'});
      expect(analysis['context']['grinderSetting'], '820');
      expect(analysis['context']['grinderSettingPrecisionDd'], 5);
      expect(analysis['context']['grinderSettingSource'], 'recorded-live-observation');
      expect((analysis['recordedGrinderObservation'] as Map)['display'], 82);
      expect(analysis['doseEvidence'], {'grams': grind['weightG'], 'source': 'grinder-reported ground weight', 'grindUuid': grind['grindUuid']});
      // Owner "off" (read through Decaid's plugin settings route): no apply, no shadow.
      final control = await chain.call('grinder-control');
      expect(control['owner'], 'off');
      expect(control['applyAvailable'], isFalse);
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );
  test(
    'Decaid grinder inventory: the E64 record is adopted, dial-in data shares its extras, and the workflow carries both',
    () async {
      expect(missing, isEmpty, reason: missing.join('; '));
      // No grinder in the workflow yet: the E64 plugin creates its record and links it.
      final start = micronWorkflow();
      (start['context'] as Map<String, dynamic>)..remove('grinderId')..remove('grinderModel')..remove('grinderBurrs');
      // A 0.7 grinder profile for the same grinder, from before the inventory existed.
      final legacy = {'key': 'grinderProfiles.v1', 'schemaVersion': 1, 'selectedProfileId': 'counter', 'profiles': {
        'counter': {'id': 'counter', 'label': 'Counter E64', 'hostGrinderId': 'gone', 'model': 'E64 WS', 'burrIdentity': 'stock',
          'calibrationEpoch': 'zero-1', 'pitchSource': 'owner', 'ownerAnchors': null},
      }};
      final chain = await Chain.start(currentWorkflow: start, dialinSettings: stepSettings, dialinStorage: {'grinderProfiles.v1': legacy});
      // Each PUT /api/v1/workflow merges into a new context map.
      Map context() => chain.current['context'] as Map;
      final deadline = DateTime.now().add(const Duration(seconds: 15));
      while (context()['grinderId'] == null || chain.inventory.records.isEmpty) {
        if (!DateTime.now().isBefore(deadline)) {
          final inventory = await chain.call('e64-diagnostics', plugin: chain.e64Id, query: {'deviceId': chain.e64DeviceId, 'read': 'inventory'});
          fail('E64 inventory sync: $inventory; workflow ${chain.current}; records ${chain.inventory.records.length}');
        }
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
      final e64 = chain.inventory.records.single;
      expect(e64.extras?['source'], 'mahlkoenig-e64.reaplugin');
      expect(context()['grinderId'], e64.id);

      var listing = await chain.call('grinders');
      expect(listing['current'], {'grinderId': e64.id, 'source': 'workflow'});
      expect(listing['migration'], {'completed': false, 'migrated': 1, 'legacyProfiles': 1});
      expect(chain.inventory.records, hasLength(1), reason: 'the legacy profile adopts the E64 record, no duplicate');
      final adopted = chain.inventory.records.single.extras!;
      expect(adopted['source'], 'mahlkoenig-e64.reaplugin', reason: "the E64 plugin's keys stay");
      expect((adopted['assisted-dialin.reaplugin'] as Map)['migratedFrom'], 'counter');
      listing = await chain.call('grinders');
      expect((listing['migration'] as Map)['completed'], isTrue);
      expect(chain.inventory.records, hasLength(1));

      // Per-grinder dial-in data through the page endpoint, into the real handler.
      final saved = await chain.call('grinders', method: 'POST', headers: page, body: {
        'grinderId': e64.id,
        'dialIn': {'settingUnit': 'micrometres', 'finerDelta': -1, 'stepSize': 5, 'calibrationEpoch': 'zero-2'},
      });
      expect(saved['saved'], isTrue);
      expect(saved['workflowSnapshot'], 'written');
      final record = (await chain.inventory.getGrinderById(e64.id))!;
      expect(record.extras?['source'], 'mahlkoenig-e64.reaplugin');
      expect(record.extras?['instanceId'], adopted['instanceId']);
      final dialIn = record.extras?['assisted-dialin.reaplugin'] as Map;
      expect(dialIn['stepSize'], 5);
      expect(dialIn['calibrationEpoch'], 'zero-2');
      final extras = context()['extras'] as Map;
      expect(extras['assisted-dialin.reaplugin'], allOf(containsPair('grinderId', e64.id), containsPair('calibrationEpoch', 'zero-2')));
      expect(extras['grinderSettingUnit'], 'micrometres', reason: 'the deep merge keeps the rest of the context');

      // Suggestions run against the workflow's grinder record.
      // Evidence shots are copies of this workflow, as Decaid stores them.
      await chain.observed((snapshot) => snapshot.observedSetting == '500');
      for (var hour = 1; hour <= 3; hour++) {
        final shot = jsonDecode(jsonEncode(chain.current)) as Map<String, dynamic>;
        (shot['context'] as Map)['grinderSetting'] = '500';
        chain.shots.add({'id': 'inventory-$hour', 'timestamp': DateTime.now().toUtc().subtract(Duration(hours: hour)).toIso8601String(),
          'workflow': shot, 'measurements': <dynamic>[]});
        await chain.call('feedback', method: 'POST',
            body: {'shotId': 'inventory-$hour', 'good': false, 'taste': 'sour', 'brewTimeSec': 22, 'brewTimeClock': 'pump'});
      }
      final suggestion = await chain.call('suggestion');
      expect(suggestion['grinder'], {'id': e64.id, 'model': e64.model, 'settingType': 'numeric', 'source': 'workflow'});
      expect(suggestion['proposedSetting'], 495, reason: '$suggestion');
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );
  test(
    'a stored shot gets its recommendation in the background: one host notice, the brew log and the workflow snapshot',
    () async {
      expect(missing, isEmpty, reason: missing.join('; '));
      final chain = await Chain.start(dialinSettings: stepSettings, currentWorkflow: micronWorkflow());
      await chain.observed((snapshot) => snapshot.observedSetting == '500');
      await sourShotsAt500(chain);
      // Every accepted publication of this plugin's notices.
      final published = <String>[];
      void watch() {
        for (final notice in chain.manager.notifications.value.where((item) => item.sourceId == chain.dialinId)) {
          final entry = '${notice.id}|${notice.message}|${notice.actions.length}';
          if (published.isEmpty || published.last != entry) published.add(entry);
        }
      }
      chain.manager.notifications.addListener(watch);
      addTearDown(() => chain.manager.notifications.removeListener(watch));

      await chain.storeShot('background-1');
      Map<String, dynamic>? recommendation;
      final deadline = DateTime.now().add(const Duration(seconds: 10));
      while (recommendation == null || published.isEmpty) {
        expect(DateTime.now().isBefore(deadline), isTrue, reason: 'background recommendation: $published');
        await Future<void>.delayed(const Duration(milliseconds: 200));
        recommendation = (await chain.call('recommendations', query: {'shotId': 'background-1'}))['recommendation'] as Map<String, dynamic>?;
      }
      expect(recommendation['status'], 'suggestion');
      expect(recommendation['message'], allOf(startsWith('Next shot: grind'), contains('finer'), contains('495')));
      // The stock host rejects the openPluginSurface action; the notice is kept without one.
      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(published, ['recommendation|${recommendation['message']}|0'], reason: 'one notice per shot');
      final batch = await chain.call('recommendations', query: {'shotIds': 'background-1,evidence-1'});
      expect((batch['recommendations'] as Map)['background-1'], recommendation);
      expect((batch['recommendations'] as Map)['evidence-1'], isNull);
      // The next shot's snapshot carries the advice it is brewed with.
      final extras = (chain.current['context'] as Map)['extras'] as Map;
      final carried = (extras['assisted-dialin.reaplugin'] as Map)['recommendation'] as Map;
      expect(carried['afterShotId'], 'background-1');
      expect(carried['message'], recommendation['message']);
      expect(extras['grinderSettingUnit'], 'micrometres');
      // A shot from history (an import) gets no advice and no notice.
      chain.shots.add({'id': 'imported', 'timestamp': DateTime.now().toUtc().subtract(const Duration(days: 2)).toIso8601String(),
        'workflow': micronWorkflow(setting: '500'), 'measurements': <dynamic>[]});
      chain.manager.dispatchEvent(chain.dialinId, 'shotStored', {'id': 'imported'});
      await Future<void>.delayed(const Duration(seconds: 3));
      expect((await chain.call('recommendations', query: {'shotId': 'imported'}))['recommendation'], isNull);
      expect(published, hasLength(1));
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
