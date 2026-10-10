import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';
import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'plugin_test_helpers.dart';

final profile = {'id': 'espresso', 'title': 'espresso', 'steps': [{'temperature': 93, 'seconds': 30}]};
Map<String, dynamic> shot(String id, String setting, {String bean = 'batch-a'}) => {'id': id, 'timestamp': '2026-10-10T01:00:00Z', 'workflow': {'context': {'beanBatchId': bean, 'grinderId': 'e64', 'grinderModel': 'E64', 'grinderSetting': setting, 'targetDoseWeight': 18.0, 'targetYield': 40.0, 'extras': {'basket': '18g', 'calibrationEpoch': 'burr-1'}}, 'profile': profile}};

Future<Map<String, dynamic>> request(PluginManager manager, String id, String requestId, Map<String, dynamic> value) async {
  final response = manager.registerPendingHttp(id, requestId);
  manager.dispatchEvent(id, 'httpRequest', {'requestId': requestId, ...value});
  return response.timeout(const Duration(seconds: 5));
}

void main() {
  test('host QuickJS harness recommends, unmarks, reloads, and abstains safely', () async {
    var shots = <Map<String, dynamic>>[shot('good', '2.0')];
    var current = shot('current', '2.1');
    var apiAvailable = true;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 8080);
    server.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      if (!apiAvailable) { request.response.statusCode = 503; await request.response.close(); return; }
      if (request.uri.path == '/api/v1/workflow') request.response.write(jsonEncode(current['workflow']));
      else if (request.uri.path == '/api/v1/shots') request.response.write(jsonEncode({'items': shots, 'total': shots.length}));
      else request.response.statusCode = 404;
      await request.response.close();
    });
    addTearDown(() => server.close(force: true));
    final root = Platform.environment['DIALIN_PLUGIN_ROOT'] ?? '.';
    final manifest = PluginManifest.fromJson(jsonDecode(File('$root/manifest.json').readAsStringSync()) as Map<String, dynamic>);
    final source = File('$root/plugin.js').readAsStringSync();
    final store = FakeKeyValueStoreService();
    Future<PluginManager> load() async {
      final manager = PluginManager(kvStore: store);
      await manager.loadPlugin(id: manifest.id, manifest: manifest, settings: const {'GrinderId': 'e64', 'GrinderModel': 'E64', 'BeanBatchId': 'batch-a', 'ProfileId': 'espresso', 'Dose': '18', 'Yield': '40', 'Basket': '18g', 'CalibrationEpoch': 'burr-1'}, jsCode: source);
      return manager;
    }
    var manager = await load();
    var response = await request(manager, manifest.id, 'mark-good', {'endpoint': 'feedback', 'method': 'POST', 'body': {'shotId': 'good', 'good': true, 'notes': 'repeatable'}});
    expect(response['status'], 200);
    response = await request(manager, manifest.id, 'recommend', {'endpoint': 'recommendation', 'method': 'GET'});
    var result = jsonDecode(response['body'] as String) as Map<String, dynamic>;
    expect(response['status'], 200); expect(result['status'], 'recommendation'); expect(result['sourceShotId'], 'good'); expect(result['grinderSetting'], '2.0'); expect(result['recordedValue'], true);
    response = await request(manager, manifest.id, 'unmark', {'endpoint': 'feedback', 'method': 'POST', 'body': {'shotId': 'good', 'good': false}});
    expect(response['status'], 200);
    response = await request(manager, manifest.id, 'abstain-unmarked', {'endpoint': 'recommendation', 'method': 'GET'});
    expect(jsonDecode(response['body'] as String)['status'], 'abstain');
    await manager.dispose(); manager = await load();
    response = await request(manager, manifest.id, 'remark', {'endpoint': 'feedback', 'method': 'POST', 'body': {'shotId': 'good', 'good': true}});
    expect(response['status'], 200); await manager.dispose(); manager = await load();
    response = await request(manager, manifest.id, 'reload-recommend', {'endpoint': 'recommendation', 'method': 'GET'});
    expect(jsonDecode(response['body'] as String)['status'], 'recommendation');
    current = shot('current', '2.1', bean: 'different-beans');
    response = await request(manager, manifest.id, 'mismatch', {'endpoint': 'recommendation', 'method': 'GET'});
    expect(jsonDecode(response['body'] as String)['status'], 'abstain');
    apiAvailable = false;
    response = await request(manager, manifest.id, 'api-failure', {'endpoint': 'recommendation', 'method': 'GET'});
    expect(response['status'], 503); expect(response['body'], isNot(contains('repeatable')));
    await manager.dispose();
  });
}
