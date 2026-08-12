const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const APP_NAME = 'Comparable DTM R';
let mainWindow = null;
let activeProcess = null;
let activeRun = null;

function getResourcePath(...parts) {
  if (app.isPackaged) return path.join(process.resourcesPath, ...parts);
  return path.join(__dirname, '..', ...parts);
}

function getAppFile(...parts) {
  if (app.isPackaged) return path.join(app.getAppPath(), ...parts);
  return path.join(__dirname, '..', ...parts);
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#0b0f11',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function emitToRenderer(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('analysis:event', event);
  }
}

function normalizeExistingFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const resolved = path.resolve(filePath);
  return fs.existsSync(resolved) ? resolved : '';
}

function findRscriptCandidates() {
  const candidates = [];

  if (process.env.R_HOME) {
    candidates.push(path.join(process.env.R_HOME, 'bin', 'Rscript.exe'));
    candidates.push(path.join(process.env.R_HOME, 'bin', 'x64', 'Rscript.exe'));
  }

  const settings = readSettings();
  if (settings.rscriptPath) candidates.push(settings.rscriptPath);

  const roots = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'R') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'R') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'R') : null
  ].filter(Boolean);

  // Prioritaskan R 4.2.2 bila tersedia.
  if (process.env.ProgramFiles) {
    candidates.unshift(
      path.join(process.env.ProgramFiles, 'R', 'R-4.2.2', 'bin', 'Rscript.exe'),
      path.join(process.env.ProgramFiles, 'R', 'R-4.2.2', 'bin', 'x64', 'Rscript.exe')
    );
  }

  for (const root of roots) {
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^R-/i.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

      for (const dir of dirs) {
        candidates.push(path.join(root, dir, 'bin', 'Rscript.exe'));
        candidates.push(path.join(root, dir, 'bin', 'x64', 'Rscript.exe'));
      }
    } catch {
      // Optional search path.
    }
  }

  try {
    const result = spawnSync('where', ['Rscript.exe'], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.status === 0 && result.stdout) {
      candidates.push(...result.stdout.split(/\r?\n/).filter(Boolean));
    }
  } catch {
    // PATH lookup optional.
  }

  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalized = normalizeExistingFile(candidate);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(normalized);
    }
  }

  return unique;
}

function getRscriptPath(requestedPath = '') {
  const requested = normalizeExistingFile(requestedPath);
  if (requested) return requested;
  return findRscriptCandidates()[0] || '';
}

function basicConfigValidation(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['Konfigurasi tidak valid.'];

  const inputs = config.inputs || {};
  const params = config.parameters || {};

  const model1Name = String(inputs.model1_name || '').trim();
  const model2Name = String(inputs.model2_name || '').trim();

  if (!model1Name) errors.push('Nama Model 1 belum diisi.');
  if (!model2Name) errors.push('Nama Model 2 belum diisi.');
  if (model1Name && model2Name && model1Name.toLowerCase() === model2Name.toLowerCase()) {
    errors.push('Nama Model 1 dan Model 2 harus berbeda.');
  }

  for (const [key, label] of [
    ['model1_dtm', 'Input Model 1'],
    ['model2_dtm', 'Input Model 2']
  ]) {
    const filePath = inputs[key];
    if (!filePath || !fs.existsSync(filePath)) {
      errors.push(`${label} tidak ditemukan.`);
    } else if (!/\.(tif|tiff|las|laz)$/i.test(filePath)) {
      errors.push(`${label} harus berformat .tif/.tiff/.las/.laz.`);
    }
  }

  if (!inputs.gcp || !fs.existsSync(inputs.gcp)) {
    errors.push('File GCP tidak ditemukan.');
  } else if (!/\.(shp|gpkg|geojson|json)$/i.test(inputs.gcp)) {
    errors.push('GCP harus berformat SHP, GPKG, GeoJSON, atau JSON spasial.');
  }

  if (!String(inputs.z_field || '').trim()) {
    errors.push('Field Z referensi belum diisi.');
  }

  if (!inputs.output_root) {
    errors.push('Folder output belum dipilih.');
  }

  if (!['simple', 'bilinear'].includes(params.extraction_method)) {
    errors.push('Metode ekstraksi raster harus simple atau bilinear.');
  }

  if (!['idw', 'nearest'].includes(params.pc_estimator)) {
    errors.push('Estimator point cloud harus idw atau nearest.');
  }

  const radius = Number(params.pc_search_radius);
  const k = Number(params.pc_k);
  const power = Number(params.pc_power);

  if (!Number.isFinite(radius) || radius <= 0) {
    errors.push('Search radius point cloud harus > 0.');
  }
  if (!Number.isInteger(k) || k < 1) {
    errors.push('Jumlah tetangga k harus bilangan bulat >= 1.');
  }
  if (!Number.isFinite(power) || power <= 0) {
    errors.push('Power IDW harus > 0.');
  }
  if (!['auto', 'class2', 'all'].includes(params.pc_ground_rule)) {
    errors.push('Ground rule point cloud tidak valid.');
  }

  return errors;
}

function toTsvValue(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\t/g, ' ');
}

function writeRuntimeConfig(config, runDir, filePath) {
  const rows = [
    ['key', 'value'],
    ['model1_name', config.inputs.model1_name],
    ['model1_path', config.inputs.model1_dtm],
    ['model2_name', config.inputs.model2_name],
    ['model2_path', config.inputs.model2_dtm],
    ['gcp_path', config.inputs.gcp],
    ['z_field', config.inputs.z_field],
    ['output_root', config.inputs.output_root],
    ['run_dir', runDir],
    ['extraction_method', config.parameters.extraction_method],
    ['pc_estimator', config.parameters.pc_estimator],
    ['pc_search_radius', config.parameters.pc_search_radius],
    ['pc_k', config.parameters.pc_k],
    ['pc_power', config.parameters.pc_power],
    ['pc_ground_rule', config.parameters.pc_ground_rule]
  ];

  fs.writeFileSync(
    filePath,
    rows.map(([k, v]) => `${toTsvValue(k)}\t${toTsvValue(v)}`).join('\n'),
    'utf8'
  );
}

function createRunConfig(config) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runName = `run_${timestamp}`;
  const outputRoot = path.resolve(config.inputs.output_root);

  fs.mkdirSync(outputRoot, { recursive: true });

  const runDir = path.join(outputRoot, runName);
  fs.mkdirSync(runDir, { recursive: true });

  const completeConfig = {
    ...config,
    app: {
      name: APP_NAME,
      version: app.getVersion(),
      created_at: new Date().toISOString(),
      run_dir: runDir
    }
  };

  const jsonPath = path.join(runDir, 'run_config.json');
  const runtimePath = path.join(runDir, 'runtime_config.tsv');

  fs.writeFileSync(jsonPath, JSON.stringify(completeConfig, null, 2), 'utf8');
  writeRuntimeConfig(config, runDir, runtimePath);

  return { runDir, jsonPath, runtimePath, completeConfig };
}

function parseEventLine(line) {
  const marker = 'APP_EVENT:';
  const idx = line.indexOf(marker);
  if (idx < 0) return null;

  const jsonText = line.slice(idx + marker.length).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return {
      type: 'log',
      level: 'warning',
      message: `Event R tidak dapat diparse: ${jsonText}`
    };
  }
}

function getBackendScriptPath(scriptName) {
  const candidates = [];

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'r', scriptName));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'r', scriptName));
  } else {
    candidates.push(path.join(__dirname, '..', 'r', scriptName));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return { missing: true, candidates };
}

function runRProcess({ rscriptPath, scriptName, args = [], modeName }) {
  return new Promise((resolve, reject) => {
    if (activeProcess) {
      reject(new Error('Masih ada proses R yang berjalan.'));
      return;
    }

    const resolvedScript = getBackendScriptPath(scriptName);
    if (typeof resolvedScript !== 'string') {
      reject(new Error(
        `Script backend tidak ditemukan. Lokasi yang diperiksa: ${resolvedScript.candidates.join(' | ')}`
      ));
      return;
    }

    const child = spawn(rscriptPath, [resolvedScript, ...args], {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        R_DEFAULT_PACKAGES:
          process.env.R_DEFAULT_PACKAGES ||
          'datasets,utils,grDevices,graphics,stats,methods'
      }
    });

    activeProcess = child;
    activeRun = { modeName, pid: child.pid };

    emitToRenderer({
      type: 'process',
      status: 'started',
      mode: modeName,
      pid: child.pid
    });

    const stdoutLines = readline.createInterface({ input: child.stdout });
    const stderrLines = readline.createInterface({ input: child.stderr });

    const rawStdout = [];
    const rawStderr = [];
    let lastStructuredError = '';

    stdoutLines.on('line', (line) => {
      rawStdout.push(line);
      const event = parseEventLine(line);

      if (event?.type === 'fatal' && event.message) {
        lastStructuredError = event.message;
      }

      if (event) {
        emitToRenderer(event);
      } else if (line.trim()) {
        emitToRenderer({ type: 'log', level: 'info', message: line });
      }
    });

    stderrLines.on('line', (line) => {
      rawStderr.push(line);
      if (line.trim()) {
        emitToRenderer({ type: 'log', level: 'error', message: line });
      }
    });

    child.on('error', (error) => {
      activeProcess = null;
      activeRun = null;
      emitToRenderer({
        type: 'process',
        status: 'error',
        mode: modeName,
        message: error.message
      });
      reject(error);
    });

    child.on('close', (code, signal) => {
      activeProcess = null;
      activeRun = null;

      const payload = {
        type: 'process',
        status: code === 0 ? 'completed' : 'failed',
        mode: modeName,
        code,
        signal,
        stderr: rawStderr.slice(-30).join('\n')
      };

      emitToRenderer(payload);

      if (code === 0) {
        resolve(payload);
      } else {
        reject(new Error(
          lastStructuredError ||
          rawStderr.slice(-10).join('\n') ||
          `Rscript berhenti dengan kode ${code}.`
        ));
      }
    });
  });
}

async function selectFile(filters) {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters
  });
  return result.canceled ? '' : result.filePaths[0];
}

ipcMain.handle('dialog:dtm', () => selectFile([
  { name: 'Terrain Model', extensions: ['tif', 'tiff', 'las', 'laz'] },
  { name: 'DTM Raster', extensions: ['tif', 'tiff'] },
  { name: 'Point Cloud', extensions: ['las', 'laz'] }
]));

ipcMain.handle('dialog:gcp', () => selectFile([
  { name: 'Data GCP', extensions: ['shp', 'gpkg', 'geojson', 'json'] }
]));

ipcMain.handle('dialog:rscript', () => selectFile([
  { name: 'Rscript', extensions: ['exe'] },
  { name: 'Semua file', extensions: ['*'] }
]));

ipcMain.handle('dialog:outputFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? '' : result.filePaths[0];
});

ipcMain.handle('app:getState', () => ({
  version: app.getVersion(),
  settings: readSettings(),
  rscriptCandidates: findRscriptCandidates(),
  packaged: app.isPackaged,
  activeRun
}));

ipcMain.handle('app:saveSettings', (_event, settings) => {
  writeSettings(settings || {});
  return { ok: true };
});

ipcMain.handle('environment:detect', (_event, requestedPath) => {
  const rscriptPath = getRscriptPath(requestedPath);
  return {
    found: Boolean(rscriptPath),
    rscriptPath,
    candidates: findRscriptCandidates()
  };
});

ipcMain.handle('environment:check', async (_event, requestedPath) => {
  const rscriptPath = getRscriptPath(requestedPath);
  if (!rscriptPath) {
    throw new Error('Rscript.exe tidak ditemukan. Pilih lokasi Rscript secara manual.');
  }

  writeSettings({ ...readSettings(), rscriptPath });

  await runRProcess({
    rscriptPath,
    scriptName: 'check_environment.R',
    args: [],
    modeName: 'environment-check'
  });

  return { ok: true, rscriptPath };
});

ipcMain.handle('analysis:validate', async (_event, payload) => {
  const config = payload?.config;
  const errors = basicConfigValidation(config);

  if (errors.length) {
    return { ok: false, errors };
  }

  const rscriptPath = getRscriptPath(payload?.rscriptPath);
  if (!rscriptPath) {
    return { ok: false, errors: ['Rscript.exe tidak ditemukan.'] };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparable-dtm-validate-'));
  const runtimePath = path.join(tempDir, 'runtime_config.tsv');

  writeRuntimeConfig(config, tempDir, runtimePath);

  try {
    await runRProcess({
      rscriptPath,
      scriptName: 'pipeline.R',
      args: ['validate', runtimePath],
      modeName: 'validation'
    });
    return { ok: true, rscriptPath };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

ipcMain.handle('analysis:start', async (_event, payload) => {
  const config = payload?.config;
  const errors = basicConfigValidation(config);

  if (errors.length) {
    return { ok: false, errors };
  }

  if (activeProcess) {
    return { ok: false, errors: ['Masih ada proses yang berjalan.'] };
  }

  const rscriptPath = getRscriptPath(payload?.rscriptPath);
  if (!rscriptPath) {
    return { ok: false, errors: ['Rscript.exe tidak ditemukan.'] };
  }

  writeSettings({
    ...readSettings(),
    rscriptPath,
    lastConfig: config
  });

  const run = createRunConfig(config);

  emitToRenderer({
    type: 'run-created',
    runDir: run.runDir,
    configPath: run.jsonPath
  });

  runRProcess({
    rscriptPath,
    scriptName: 'pipeline.R',
    args: ['run', run.runtimePath],
    modeName: 'analysis'
  }).catch((error) => {
    emitToRenderer({
      type: 'fatal',
      message: error.message,
      runDir: run.runDir
    });
  });

  return {
    ok: true,
    runDir: run.runDir,
    configPath: run.jsonPath
  };
});

ipcMain.handle('analysis:cancel', async () => {
  if (!activeProcess) {
    return { ok: false, message: 'Tidak ada proses aktif.' };
  }

  const pid = activeProcess.pid;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true
    });
  } else {
    activeProcess.kill('SIGTERM');
  }

  emitToRenderer({ type: 'process', status: 'cancelled', pid });
  return { ok: true };
});

ipcMain.handle('result:readSummary', (_event, runDir) => {
  if (!runDir) return { ok: false, error: 'Run directory kosong.' };

  const summaryPath = path.join(runDir, 'result_summary.json');
  if (!fs.existsSync(summaryPath)) {
    return { ok: false, error: 'result_summary.json belum tersedia.' };
  }

  try {
    return {
      ok: true,
      data: JSON.parse(fs.readFileSync(summaryPath, 'utf8')),
      summaryPath
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('shell:openPath', async (_event, targetPath) => {
  if (!targetPath || !fs.existsSync(targetPath)) return 'Path tidak ditemukan.';
  return shell.openPath(targetPath);
});

ipcMain.handle('shell:showItem', (_event, targetPath) => {
  if (targetPath && fs.existsSync(targetPath)) {
    shell.showItemInFolder(targetPath);
  }
  return { ok: true };
});

app.setName(APP_NAME);
app.setAppUserModelId('com.pmnp.comparabledtm');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (activeProcess) {
    event.preventDefault();

    const pid = activeProcess.pid;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true
      });
    } else {
      activeProcess.kill('SIGTERM');
    }

    activeProcess = null;
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
