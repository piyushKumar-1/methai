// Resolves the library straight from ../src, with React and React Native taken only from this
// app's node_modules (the library's own dev copies would otherwise load a second React).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '..');
const escape = s => s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');

const config = getDefaultConfig(__dirname);
config.watchFolders = [root];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.extraNodeModules = { 'react-native-screen-context': path.join(root, 'src') };
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  new RegExp(`^${escape(path.join(root, 'node_modules'))}\\/.*`),
];

module.exports = config;
