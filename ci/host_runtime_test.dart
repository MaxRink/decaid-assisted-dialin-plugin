import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';
import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'plugin_test_helpers.dart';

Future<Map<String, dynamic>> request(PluginManager manager, String id, String requestId, Map<String, dynamic> value) async {
  final response = manager.registerPendingHttp(id, requestId);
  manager.dispatchEvent(id, 'httpRequest', {'requestId': requestId, ...value});
  return response.timeout(const Duration(seconds: 5));
}

Map<String, dynamic> shot(String id, String setting, {String bean = 'batch-a'}) => {
  'id': id, 'timestamp': id == 'new' ? '2026-10-10T02:00:00Z' : '2026-10-10T01:00:00Z',
  'workflow': {'context': {'beanBatchId': bean, 'grinderId': 'e64', 'grinderModel': 'E64', 'grinderSetting': setting}, 'profile': {'title': 'espresso'}},
};

void main() {
  test('real QuickJS plugin stores feedback and abstains on changed bean', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 8080);
    server.listen((request) {
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({'items': [shot('old', '2.0', bean: 'other')], 'total': 1}));
      request.response.close();
    });
    addTearDown(server.close);
    final root = Platform.environment['DIALIN_PLUGIN_ROOT'] ?? '.';
    final manifest = PluginManifest.fromJson(jsonDecode(File('$root/manifest.json').readAsStringSync()) as Map<String, dynamic>);
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await manager.loadPlugin(id: manifest.id, manifest: manifest, settings: const {'GrinderId': 'e64', 'GrinderModel': 'E64', 'BeanBatchId': 'batch-a', 'ProfileId': 'espresso'}, jsCode: File('$root/plugin.js').readAsStringSync());
    final saved = await request(manager, manifest.id, 'feedback', {'endpoint': 'feedback', 'method': 'POST', 'body': {'shotId': 'old', 'good': true}});
    expect(saved['status'], 200);
    final result = await request(manager, manifest.id, 'recommendation', {'endpoint': 'recommendation', 'method': 'GET'});
    expect(result['status'], 200);
    expect(jsonDecode(result['body'] as String)['status'], 'abstain');
    final ui = await request(manager, manifest.id, 'ui', {'endpoint': 'ui', 'method': 'GET'});
    expect(ui['status'], 200);
    expect(ui['body'], contains('Assisted dial-in'));
  });
}
