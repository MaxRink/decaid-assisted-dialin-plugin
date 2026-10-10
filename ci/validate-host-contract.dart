import 'dart:io';
import 'package:reaprime/src/plugins/plugin_package.dart';

void main(List<String> args) {
  if (args.length != 1) { stderr.writeln('usage: validate-host-contract.dart PLUGIN_ROOT'); exitCode = 64; return; }
  final package = resolvePluginPackage(Directory(args.single));
  final manifest = package.manifestJson;
  final permissions = (manifest['permissions'] as List).cast<String>();
  final endpoints = (manifest['api'] as List).cast<Map>();
  if (package.manifest.id != 'assisted-dialin.reaplugin' ||
      !permissions.contains('api') || !permissions.contains('pluginStorage') ||
      !permissions.contains('events.shots') || endpoints.length != 5 ||
      !endpoints.every((entry) => entry['type'] == 'http')) {
    throw StateError('assisted dial-in manifest is incompatible with the pinned Decaid host');
  }
  stdout.writeln('validated ${package.manifest.id} ${package.manifest.version}');
}
