import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';
import 'package:reaprime/src/plugins/plugin_manifest.dart';

import 'plugin_test_helpers.dart';

final profile = {
  'id': 'espresso',
  'title': 'espresso',
  'steps': [
    {'temperature': 93, 'seconds': 30},
  ],
};
Map<String, dynamic> shot(
  String id,
  String setting, {
  String bean = 'batch-a',
}) => {
  'id': id,
  'timestamp': '2026-10-10T01:00:00Z',
  'workflow': {
    'context': {
      'beanBatchId': bean,
      'grinderId': 'e64',
      'grinderModel': 'E64',
      'grinderSetting': setting,
      'targetDoseWeight': 18.0,
      'targetYield': 40.0,
      'extras': {'basket': '18g', 'calibrationEpoch': 'burr-1'},
    },
    'profile': profile,
  },
};

Map<String, dynamic> fullShot(
  String id,
  String setting,
  DateTime started, {
  int elapsedSeconds = 20,
  String bean = 'batch-a',
  String calibration = 'burr-1',
}) {
  final start = started.toUtc();
  final end = start.add(Duration(seconds: elapsedSeconds));
  return {
    'id': id,
    'timestamp': start.toIso8601String(),
    'workflow': {
      'context': {
        'beanBatchId': bean,
        'grinderId': 'e64',
        'grinderModel': 'E64',
        'grinderSetting': setting,
        'targetDoseWeight': 18.0,
        'targetYield': 40.0,
        'extras': {
          'basket': '18g',
          'calibrationEpoch': calibration,
          'burrIdentity': 'burr-1',
          'grinderSettingUnit': 'dial-mark',
          'beanType': 'Arabica',
          'roastLevel': 'light',
        },
      },
      'profile': profile,
    },
    'measurements': [
      {
        'machine': {
          'timestamp': start.toIso8601String(),
          'pressure': 8.0,
          'targetPressure': 9.0,
          'flow': 1.0,
          'targetFlow': 1.2,
          'mixTemperature': 92.0,
          'targetMixTemperature': 93.0,
          'groupTemperature': 92.5,
          'targetGroupTemperature': 93.0,
        },
        'scale': {
          'timestamp': start.toIso8601String(),
          'weight': 0.0,
          'weightFlow': 0.0,
        },
      },
      {
        'machine': {
          'timestamp': start.add(const Duration(seconds: 10)).toIso8601String(),
          'pressure': 8.5,
          'targetPressure': 9.0,
          'flow': 1.5,
          'targetFlow': 1.2,
          'mixTemperature': 92.5,
          'targetMixTemperature': 93.0,
          'groupTemperature': 92.8,
          'targetGroupTemperature': 93.0,
        },
        'scale': {
          'timestamp': start.add(const Duration(seconds: 10)).toIso8601String(),
          'weight': 20.0,
          'weightFlow': 2.0,
        },
      },
      {
        'machine': {
          'timestamp': end.toIso8601String(),
          'pressure': 9.0,
          'targetPressure': 9.0,
          'flow': 1.8,
          'targetFlow': 1.2,
          'mixTemperature': 93.0,
          'targetMixTemperature': 93.0,
          'groupTemperature': 93.0,
          'targetGroupTemperature': 93.0,
        },
        'scale': {
          'timestamp': end.toIso8601String(),
          'weight': 40.0,
          'weightFlow': 2.0,
        },
      },
    ],
    'volume': 38.5,
    'annotations': {'actualDoseWeight': 18.2, 'actualYield': 40.1},
    'burrIdentity': 'ignored-top-level-field',
  };
}

Future<Map<String, dynamic>> request(
  PluginManager manager,
  String id,
  String requestId,
  Map<String, dynamic> value,
) async {
  final response = manager.registerPendingHttp(id, requestId);
  manager.dispatchEvent(id, 'httpRequest', {'requestId': requestId, ...value});
  return response.timeout(const Duration(seconds: 5));
}

void main() {
  test(
    'host QuickJS harness recommends, unmarks, reloads, and abstains safely',
    () async {
      var shots = <Map<String, dynamic>>[shot('good', '2.0')];
      var current = shot('current', '2.1');
      var apiAvailable = true;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 8080);
      server.listen((request) async {
        request.response.headers.contentType = ContentType.json;
        if (!apiAvailable) {
          request.response.statusCode = 503;
          await request.response.close();
          return;
        }
        if (request.uri.path == '/api/v1/workflow')
          request.response.write(jsonEncode(current['workflow']));
        else if (request.uri.path == '/api/v1/shots')
          request.response.write(
            jsonEncode({'items': shots, 'total': shots.length}),
          );
        else
          request.response.statusCode = 404;
        await request.response.close();
      });
      addTearDown(() => server.close(force: true));
      final root = Platform.environment['DIALIN_PLUGIN_ROOT'] ?? '.';
      final manifest = PluginManifest.fromJson(
        jsonDecode(File('$root/manifest.json').readAsStringSync())
            as Map<String, dynamic>,
      );
      final source = File('$root/plugin.js').readAsStringSync();
      final store = FakeKeyValueStoreService();
      Future<PluginManager> load() async {
        final manager = PluginManager(kvStore: store);
        await manager.loadPlugin(
          id: manifest.id,
          manifest: manifest,
          settings: const {
            'GrinderId': 'e64',
            'GrinderModel': 'E64',
            'BeanBatchId': 'batch-a',
            'ProfileId': 'espresso',
            'Dose': '18',
            'Yield': '40',
            'Basket': '18g',
            'CalibrationEpoch': 'burr-1',
          },
          jsCode: source,
        );
        return manager;
      }

      var manager = await load();
      var response = await request(manager, manifest.id, 'mark-good', {
        'endpoint': 'feedback',
        'method': 'POST',
        'body': {'shotId': 'good', 'good': true, 'notes': 'repeatable'},
      });
      expect(response['status'], 200);
      response = await request(manager, manifest.id, 'recommend', {
        'endpoint': 'recommendation',
        'method': 'GET',
      });
      var result =
          jsonDecode(response['body'] as String) as Map<String, dynamic>;
      expect(response['status'], 200);
      expect(result['status'], 'recommendation');
      expect(result['sourceShotId'], 'good');
      expect(result['grinderSetting'], '2.0');
      expect(result['recordedValue'], true);
      response = await request(manager, manifest.id, 'unmark', {
        'endpoint': 'feedback',
        'method': 'POST',
        'body': {'shotId': 'good', 'good': false},
      });
      expect(response['status'], 200);
      response = await request(manager, manifest.id, 'abstain-unmarked', {
        'endpoint': 'recommendation',
        'method': 'GET',
      });
      expect(jsonDecode(response['body'] as String)['status'], 'abstain');
      await manager.dispose();
      manager = await load();
      response = await request(manager, manifest.id, 'remark', {
        'endpoint': 'feedback',
        'method': 'POST',
        'body': {'shotId': 'good', 'good': true},
      });
      expect(response['status'], 200);
      await manager.dispose();
      manager = await load();
      response = await request(manager, manifest.id, 'reload-recommend', {
        'endpoint': 'recommendation',
        'method': 'GET',
      });
      expect(
        jsonDecode(response['body'] as String)['status'],
        'recommendation',
      );
      // Exercise concurrent requests through the actual unkeyed host acknowledgement bridge.
      shots = [shot('older', '1.9'), shot('newer', '2.2')];
      shots[0]['timestamp'] = '2026-10-10T02:00:00Z';
      shots[1]['timestamp'] = '2026-10-10T03:00:00Z';
      manager.dispatchEvent(manifest.id, 'shotStored', {'id': 'newer'});
      final writes = await Future.wait([
        request(manager, manifest.id, 'parallel-older', {
          'endpoint': 'feedback',
          'method': 'POST',
          'body': {'shotId': 'older', 'good': true},
        }),
        request(manager, manifest.id, 'parallel-newer', {
          'endpoint': 'feedback',
          'method': 'POST',
          'body': {'shotId': 'newer', 'good': true},
        }),
      ]);
      expect(writes.map((value) => value['status']), everyElement(200));
      await manager.dispose();
      manager = await load();
      response = await request(manager, manifest.id, 'parallel-reload', {
        'endpoint': 'recommendation',
        'method': 'GET',
      });
      result = jsonDecode(response['body'] as String) as Map<String, dynamic>;
      expect(result['sourceShotId'], 'newer');
      expect(result['grinderSetting'], '2.2');
      (current['workflow'] as Map<String, dynamic>)['profile'] = {
        'title': 'espresso',
        'steps': [
          {'temperature': 85, 'seconds': 10},
        ],
      };
      response = await request(manager, manifest.id, 'profile-mismatch', {
        'endpoint': 'recommendation',
        'method': 'GET',
      });
      expect(jsonDecode(response['body'] as String)['status'], 'abstain');
      current = shot('current', '2.1', bean: 'different-beans');
      response = await request(manager, manifest.id, 'mismatch', {
        'endpoint': 'recommendation',
        'method': 'GET',
      });
      expect(jsonDecode(response['body'] as String)['status'], 'abstain');
      apiAvailable = false;
      response = await request(manager, manifest.id, 'api-failure', {
        'endpoint': 'recommendation',
        'method': 'GET',
      });
      expect(response['status'], 503);
      expect(response['body'], isNot(contains('repeatable')));
      await manager.dispose();
    },
  );

  test('actual host bridge covers rich suggestions, feedback persistence, and research replay', () async {
    final now = DateTime.now().toUtc();
    final full = <String, Map<String, dynamic>>{
      for (var i = 0; i < 3; i++)
        'shot-$i': fullShot(
          'shot-$i',
          '2.0',
          now.subtract(Duration(hours: i + 1)),
        ),
    };
    var currentCalibration = 'burr-1';
    var current = fullShot(
      'current',
      '2.0',
      now,
      calibration: currentCalibration,
    )['workflow'];
    final summaries = full.values.map((entry) {
      final summary = Map<String, dynamic>.from(entry)..remove('measurements');
      return summary;
    }).toList();
    final beanBatch = {
      'id': 'batch-a',
      'beanId': 'bean-1',
      'roastLevel': 'light',
      'roastDate': '2026-09-20',
    };
    final bean = {
      'id': 'bean-1',
      'species': 'Arabica',
      'decaf': false,
      'processing': 'washed',
      'variety': ['Bourbon'],
      'country': 'Ethiopia',
      'region': 'Yirgacheffe',
    };
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 8080);
    server.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      if (request.uri.path == '/api/v1/workflow') {
        request.response.write(jsonEncode(current));
      } else if (request.uri.path == '/api/v1/bean-batches/batch-a') {
        request.response.write(jsonEncode(beanBatch));
      } else if (request.uri.path == '/api/v1/beans/bean-1') {
        request.response.write(jsonEncode(bean));
      } else if (request.uri.path == '/api/v1/shots') {
        // Summary responses intentionally omit measurements; the plugin must fetch
        // the full record before using saved machine timestamps.
        request.response.write(
          jsonEncode({'items': summaries, 'total': summaries.length}),
        );
      } else if (request.uri.path.startsWith('/api/v1/shots/')) {
        final id = request.uri.pathSegments.last;
        final record = full[id];
        if (record == null) {
          request.response.statusCode = 404;
        } else {
          request.response.write(jsonEncode(record));
        }
      } else {
        request.response.statusCode = 404;
      }
      await request.response.close();
    });
    addTearDown(() => server.close(force: true));

    final root = Platform.environment['DIALIN_PLUGIN_ROOT'] ?? '.';
    final manifest = PluginManifest.fromJson(
      jsonDecode(File('$root/manifest.json').readAsStringSync())
          as Map<String, dynamic>,
    );
    final source = File('$root/plugin.js').readAsStringSync();
    final store = FakeKeyValueStoreService();
    Future<PluginManager> load() async {
      final manager = PluginManager(kvStore: store);
      await manager.loadPlugin(
        id: manifest.id,
        manifest: manifest,
        settings: const {
          'GrinderId': 'e64',
          'GrinderModel': 'E64',
          'BeanBatchId': 'batch-a',
          'ProfileId': 'espresso',
          'Dose': '18',
          'Yield': '40',
          'Basket': '18g',
          'CalibrationEpoch': 'burr-1',
          'BurrIdentity': 'burr-1',
          'CurrentSetting': '2.0',
          'SettingUnit': 'dial-mark',
          'TargetTimeSec': '30',
          'TimeToleranceSec': '1',
          'EvidenceMaxAgeDays': '14',
          'StepSize': '1',
          'NumericFinerDelta': '1',
          'MinSetting': '0',
          'MaxSetting': '90',
        },
        jsCode: source,
      );
      return manager;
    }

    var manager = await load();
    Future<Map<String, dynamic>> call(
      String id,
      String endpoint,
      String method, [
      Map<String, dynamic>? body,
    ]) async {
      final response = await request(manager, manifest.id, id, {
        'endpoint': endpoint,
        'method': method,
        if (body != null) 'body': body,
      });
      expect(
        response['status'],
        200,
        reason: '$endpoint failed: ${response['body']}',
      );
      return jsonDecode(response['body'] as String) as Map<String, dynamic>;
    }

    final beanContext = await call('bean-context', 'bean-context', 'GET');
    expect(beanContext['status'], 'available');
    expect(beanContext['beanBatchId'], 'batch-a');
    expect(beanContext['beanId'], 'bean-1');
    expect((beanContext['bean'] as Map)['species'], 'Arabica');
    expect((beanContext['batch'] as Map)['roastLevel'], 'light');
    expect(beanContext['provenance'], contains('fetched now'));
    expect(beanContext['requiresHistoricalConfirmation'], true);
    final references = await call('references', 'references', 'GET');
    expect(references['schemaVersion'], 1);
    final referenceSources = references['sources'] as List<dynamic>;
    expect(referenceSources.length, greaterThan(0));
    expect(referenceSources.length, lessThanOrEqualTo(128));
    expect(
      referenceSources.every(
        (source) => (source as Map)['url'].toString().startsWith('https://'),
      ),
      true,
    );
    expect(
      (references['provenance'] as String).toLowerCase(),
      contains('offline reviewed reference'),
    );

    final measuredBeanDose = {
      'deviceId': 'aux-scale-1',
      'connectionRole': 'auxiliary',
      'purpose': 'beans',
      'weightG': 18.5,
      'units': 'g',
      'capturedAt': '2026-10-11T10:00:00.000Z',
      'sampleTimestamp': '2026-10-11T09:59:59.500Z',
      'userConfirmed': true,
    };
    var invalidMeasurement = Map<String, dynamic>.from(measuredBeanDose)
      ..['connectionRole'] = 'primary';
    var response = await request(manager, manifest.id, 'bean-dose-primary', {
      'endpoint': 'feedback',
      'method': 'POST',
      'body': {
        'shotId': 'shot-0',
        'good': true,
        'measuredBeanDose': invalidMeasurement,
      },
    });
    expect(response['status'], 400);
    invalidMeasurement = Map<String, dynamic>.from(measuredBeanDose)
      ..['capturedAt'] = '2026-02-31T10:00:00Z';
    response = await request(manager, manifest.id, 'bean-dose-calendar', {
      'endpoint': 'feedback',
      'method': 'POST',
      'body': {
        'shotId': 'shot-0',
        'good': true,
        'measuredBeanDose': invalidMeasurement,
      },
    });
    expect(response['status'], 400);
    for (var i = 0; i < 3; i++) {
      final result = await call('good-$i', 'feedback', 'POST', {
        'shotId': 'shot-$i',
        'good': true,
        'taste': 'sour',
        'flavour': {
          'descriptors': ['berry', 'bright'],
          'acidity': 4,
          'bitterness': 1,
          'sweetness': 3,
          'body': 3,
          'astringency': 1,
          'overall': 'under-extracted',
        },
        'confirmedContext': {'beanType': 'Arabica', 'roastLevel': 'light'},
      });
      expect(result['saved'], true);
    }
    final savedMeasurement = await call('bean-dose-save', 'feedback', 'POST', {
      'shotId': 'shot-0',
      'good': true,
      'measuredBeanDose': measuredBeanDose,
    });
    expect(savedMeasurement['saved'], true);
    final analysis = await call('analysis', 'analysis', 'POST', {
      'shotId': 'shot-0',
    });
    expect(analysis['shotId'], 'shot-0');
    expect((analysis['context'] as Map)['beanType'], 'Arabica');
    expect((analysis['context'] as Map)['roastLevel'], 'light');
    expect((analysis['feedback'] as Map)['good'], true);
    final metrics = analysis['metrics'] as Map<String, dynamic>;
    expect(metrics['elapsedSec'], 20);
    expect(
      (metrics['machine'] as Map)['pressure']['timeWeightedMae'],
      isA<num>(),
    );
    expect((metrics['machine'] as Map)['flow']['timeWeightedMae'], isA<num>());
    expect(
      (metrics['machine'] as Map)['mixTemperature']['timeWeightedMae'],
      isA<num>(),
    );
    expect(
      (metrics['machine'] as Map)['groupTemperature']['timeWeightedMae'],
      isA<num>(),
    );
    expect((metrics['scale'] as Map)['finalMeasuredWeightG'], 40.0);
    expect((metrics['scale'] as Map)['brewFlowGPerSec'], 2.0);
    expect(
      (analysis['measuredBeanDose'] as Map)['source'],
      'operator-confirmed auxiliary scale capture',
    );
    expect((analysis['measuredBeanDose'] as Map)['weightG'], 18.5);
    expect(
      (metrics['annotations'] as Map)['actualYieldToMeasuredBeanDoseRatio'],
      closeTo(40 / 18.5, 1e-9),
    );
    expect((metrics['recipeTargets'] as Map)['ratio'], closeTo(40 / 18, 1e-9));
    expect(analysis['provenance'], contains('Saved full shot'));
    await manager.dispose();
    manager = await load();
    final reloadedAnalysis = await call(
      'bean-dose-reload',
      'analysis',
      'POST',
      {'shotId': 'shot-0'},
    );
    expect(
      (reloadedAnalysis['feedback'] as Map)['measuredBeanDose'],
      isNotNull,
    );
    expect(
      ((reloadedAnalysis['feedback'] as Map)['measuredBeanDose']
          as Map)['source'],
      'operator-confirmed auxiliary scale capture',
    );
    var result = await call('suggestion', 'suggestion', 'GET');
    expect(result['status'], 'suggestion');
    expect(result['sourceShotIds'], hasLength(3));
    expect(result['medianElapsedTimeSec'], 20);
    expect(result['timeDirection'], 'finer');
    expect(result['direction'], 'finer');
    expect(
      (result['evidence'] as List).every(
        (entry) =>
            entry['timingProvenance'].toString().contains('saved machine'),
      ),
      true,
    );

    // A structured negative mark must survive a real plugin unload/reload.
    result = await call('negative', 'feedback', 'POST', {
      'shotId': 'shot-0',
      'good': false,
      'taste': 'balanced',
      'flavour': {
        'descriptors': ['dry'],
        'acidity': 2,
        'bitterness': 4,
        'sweetness': 2,
        'body': 3,
        'astringency': 4,
        'overall': 'over-extracted',
      },
    });
    expect(result['saved'], true);
    await manager.dispose();
    manager = await load();
    final negativeAnalysis = await call(
      'negative-analysis',
      'analysis',
      'POST',
      {'shotId': 'shot-0'},
    );
    expect((negativeAnalysis['feedback'] as Map)['good'], false);
    expect(
      (negativeAnalysis['feedback'] as Map)['flavour']['overall'],
      'over-extracted',
    );
    result = await call('negative-check', 'suggestion', 'GET');
    expect(result['status'], 'abstain');
    expect(result['sourceShotIds'], hasLength(3));
    expect((result['sourceShotIds'] as List), contains('shot-0'));

    // Exercise scoped GbS2 state across two research requests.
    final scope = {
      'grinderId': 'e64',
      'beanBatchId': 'batch-a',
      'burrIdentity': 'burr-1',
      'calibrationEpoch': 'burr-1',
      'profile': 'espresso',
    };
    final first = await call('research-gbs2-1', 'research', 'POST', {
      'operation': 'adjust',
      'algorithm': 'GbS2',
      'firmwareBuild': 'HEM-HSG-HMI-S01 V01.16-24',
      'coordinateUnit': 'deci-micrometre',
      'scope': scope,
      'input': {
        'actualBrewTimeMs': 20000,
        'targetBrewTimeMs': 30000,
        'estimatedDdDum': 1000,
        'setpointDdDum': 1000,
        'toleranceMs': 1000,
      },
      'options': {'history': []},
    });
    expect(first['provider'], 'recovered-firmware-replay');
    final envelope = first['stateEnvelope'] as Map<String, dynamic>;
    expect(envelope['scope'], scope);
    final second = await call('research-gbs2-2', 'research', 'POST', {
      'operation': 'adjust',
      'algorithm': 'GbS2',
      'firmwareBuild': 'HEM-HSG-HMI-S01 V01.16-24',
      'coordinateUnit': 'deci-micrometre',
      'scope': scope,
      'stateEnvelope': envelope,
      'input': {
        'actualBrewTimeMs': 28000,
        'targetBrewTimeMs': 30000,
        'estimatedDdDum': 1000,
        'setpointDdDum': 1000,
        'toleranceMs': 1000,
      },
    });
    expect((second['stateEnvelope'] as Map)['state']['history'], hasLength(2));
    final ddEff = await call('research-ddeff', 'research', 'POST', {
      'operation': 'ddEff',
      'firmwareBuild': 'HEM-HSG-HMI-S01 V01.16-24',
      'coordinateUnit': 'deci-micrometre',
      'input': {'initialDdDum': 1000, 'calls': 2},
    });
    expect(ddEff['provider'], 'recovered-firmware-replay');
    expect(ddEff['result'], [1000, 1000]);
    final manual = await call('research-manual', 'research', 'POST', {
      'operation': 'manual',
      'input': {
        'profile': 'df64_gen1',
        'targetTimeSec': 30,
        'actualTimeSec': 20,
        'currentDial': 10,
        'stepMarks': 1,
        'numericFinerDelta': 1,
      },
    });
    expect(manual['provider'], 'DF54/DF64-community-heuristic');
    expect((manual['result'] as Map)['direction'], 'finer');

    // Conflicting taste/time evidence and a calibration mismatch must abstain.
    for (var i = 0; i < 3; i++) {
      await call('retag-$i', 'feedback', 'POST', {
        'shotId': 'shot-$i',
        'good': true,
        'taste': i == 1 ? 'bitter' : 'sour',
      });
    }
    result = await call('taste-conflict', 'suggestion', 'GET');
    expect(result['status'], 'abstain');
    expect(result['reason'], contains('Taste feedback conflicts'));
    for (var i = 0; i < 3; i++) {
      await call('retaste-$i', 'feedback', 'POST', {
        'shotId': 'shot-$i',
        'good': true,
        'taste': 'bitter',
      });
    }
    result = await call('time-conflict', 'suggestion', 'GET');
    expect(result['status'], 'abstain');
    expect(result['reason'], contains('Taste and timing suggest opposite'));
    currentCalibration = 'burr-2';
    (current['context'] as Map<String, dynamic>)['extras']['calibrationEpoch'] =
        currentCalibration;
    result = await call('calibration-mismatch', 'suggestion', 'GET');
    expect(result['status'], 'abstain');
    expect(result['sourceShotIds'], isEmpty);
    await manager.dispose();
  });
}
