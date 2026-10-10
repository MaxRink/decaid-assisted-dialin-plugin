import 'package:reaprime/src/services/storage/kv_store_service.dart';

class FakeKeyValueStoreService implements KeyValueStoreService {
  final Map<String, Map<String, Object>> values = {};
  @override Future<void> initialize() async {}
  @override Future<Object?> get({String namespace = 'default', required String key}) async => values[namespace]?[key];
  @override Future<void> set({String namespace = 'default', required String key, required Object value}) async { values.putIfAbsent(namespace, () => {})[key] = value; }
  @override Future<bool> delete({String namespace = 'default', required String key}) async => values[namespace]?.remove(key) != null;
  @override Future<List<String>> keys({String namespace = 'default'}) async => values[namespace]?.keys.toList() ?? [];
  @override List<String> get namespaces => values.keys.toList();
  @override Future<Map<String, Object>> getAll({String namespace = 'default'}) async => Map<String, Object>.from(values[namespace] ?? {});
}
