const { rm } = require('node:fs/promises');
const path = require('node:path');

// Electron Builder can invoke beforePack for several targets in one build.
// Share the cleanup promise so later targets never delete earlier artifacts.
let cleanup;
module.exports = () => cleanup ??= rm(path.join(__dirname, '..', 'dist'), { recursive: true, force: true });
