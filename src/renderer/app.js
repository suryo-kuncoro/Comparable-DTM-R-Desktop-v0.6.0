const $ = (id) => document.getElementById(id);

let currentRunDir = '';
let processRunning = false;
let currentSummary = null;

function log(message, level = 'info') {
  const now = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const prefix =
    level === 'error' ? 'ERROR' :
    level === 'warning' ? 'WARN ' :
    level === 'success' ? 'OK   ' : 'INFO ';

  const output = $('logOutput');
  output.textContent += `\n[${now}] ${prefix} ${message}`;
  output.scrollTop = output.scrollHeight;
}

function setProgress(percent, stage) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const text = stage || 'Processing';

  $('progressPercent').textContent = `${Math.round(p)}%`;
  $('progressFill').style.width = `${p}%`;
  $('progressStage').textContent = text;

  $('mainPercent').textContent = `${Math.round(p)}%`;
  $('mainProgressFill').style.width = `${p}%`;
  $('mainStage').textContent = text;
}

function setEnvStatus(text, type = 'neutral') {
  const el = $('envStatus');
  el.textContent = text;
  el.className = `status-pill ${type}`;
}

function setRunStatus(text, type = 'neutral') {
  const el = $('runStatus');
  el.textContent = text;
  el.className = `status-pill ${type}`;
}

function setProcessState(running) {
  processRunning = running;
  $('runBtn').disabled = running;
  $('validateBtn').disabled = running;
  $('cancelBtn').disabled = !running;
}

function detectInputType(filePath) {
  const p = String(filePath || '').toLowerCase();
  if (/\.(tif|tiff)$/.test(p)) return 'raster';
  if (/\.(las|laz)$/.test(p)) return 'pointcloud';
  return 'unknown';
}

function refreshInputType(modelNo) {
  const pathEl = $(`model${modelNo}Dtm`);
  const typeEl = $(`model${modelNo}Type`);
  const behaviourEl = $(`model${modelNo}Behaviour`);
  const type = detectInputType(pathEl.value);

  if (type === 'raster') {
    typeEl.textContent = 'DTM RASTER';
    typeEl.className = 'type-pill raster';
    behaviourEl.innerHTML =
      'Diproses sebagai <b>DTM raster</b>. Nilai Z diekstrak langsung pada koordinat GCP menggunakan parameter raster.';
  } else if (type === 'pointcloud') {
    typeEl.textContent = 'POINT CLOUD';
    typeEl.className = 'type-pill pointcloud';
    behaviourEl.innerHTML =
      'Diproses sebagai <b>final/classified point cloud</b>. Neighborhood di sekitar GCP dibaca langsung; tidak dibuat DTM raster sementara.';
  } else {
    typeEl.textContent = pathEl.value ? 'UNKNOWN' : 'Belum dipilih';
    typeEl.className = 'type-pill neutral';
    behaviourEl.textContent = pathEl.value
      ? 'Ekstensi file tidak dikenali.'
      : 'Pilih file untuk melihat cara model akan diproses.';
  }
}

function getConfig() {
  return {
    inputs: {
      model1_name: $('model1Name').value.trim(),
      model1_dtm: $('model1Dtm').value.trim(),
      model2_name: $('model2Name').value.trim(),
      model2_dtm: $('model2Dtm').value.trim(),
      gcp: $('gcpPath').value.trim(),
      z_field: $('zField').value.trim(),
      output_root: $('outputRoot').value.trim()
    },
    parameters: {
      extraction_method: $('extractionMethod').value,
      pc_estimator: $('pcEstimator').value,
      pc_search_radius: Number($('pcSearchRadius').value),
      pc_k: Number($('pcK').value),
      pc_power: Number($('pcPower').value),
      pc_ground_rule: $('pcGroundRule').value
    }
  };
}

function applyConfig(config) {
  if (!config) return;
  const inputs = config.inputs || {};
  const params = config.parameters || {};

  if (inputs.model1_name) $('model1Name').value = inputs.model1_name;
  if (inputs.model1_dtm) $('model1Dtm').value = inputs.model1_dtm;
  if (inputs.model2_name) $('model2Name').value = inputs.model2_name;
  if (inputs.model2_dtm) $('model2Dtm').value = inputs.model2_dtm;
  if (inputs.gcp) $('gcpPath').value = inputs.gcp;
  if (inputs.z_field) $('zField').value = inputs.z_field;
  if (inputs.output_root) $('outputRoot').value = inputs.output_root;

  if (params.extraction_method) $('extractionMethod').value = params.extraction_method;
  if (params.pc_estimator) $('pcEstimator').value = params.pc_estimator;
  if (params.pc_search_radius != null) $('pcSearchRadius').value = params.pc_search_radius;
  if (params.pc_k != null) $('pcK').value = params.pc_k;
  if (params.pc_power != null) $('pcPower').value = params.pc_power;
  if (params.pc_ground_rule) $('pcGroundRule').value = params.pc_ground_rule;

  refreshInputType(1);
  refreshInputType(2);
}

function fmt(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function prettyType(type) {
  return type === 'pointcloud' ? 'POINT CLOUD · RMSE' : 'DTM RASTER · RMSE';
}

function renderSummary(data) {
  currentSummary = data;
  $('resultDashboard').classList.remove('hidden');

  $('winnerName').textContent = data.winner || '—';
  $('winnerReason').textContent = data.winner_reason || '—';

  const m1 = data.model1 || {};
  const m2 = data.model2 || {};

  $('model1ResultName').textContent = m1.name || 'Model 1';
  $('model1Rmse').textContent = fmt(m1.rmse);
  $('model1Bias').textContent = fmt(m1.bias);
  $('model1Sd').textContent = fmt(m1.sd);
  $('model1ResultType').textContent = prettyType(m1.input_type);

  $('model2ResultName').textContent = m2.name || 'Model 2';
  $('model2Rmse').textContent = fmt(m2.rmse);
  $('model2Bias').textContent = fmt(m2.bias);
  $('model2Sd').textContent = fmt(m2.sd);
  $('model2ResultType').textContent = prettyType(m2.input_type);

  $('commonGcp').textContent = Number.isFinite(Number(data.common_valid_gcp))
    ? String(data.common_valid_gcp) : '—';
  $('totalGcp').textContent = Number.isFinite(Number(data.total_gcp))
    ? String(data.total_gcp) : '—';
  $('deltaRmse').textContent = fmt(data.delta_rmse);
}

async function refreshSummary(runDir) {
  if (!runDir) return;
  const response = await window.appApi.readSummary(runDir);
  if (!response.ok) {
    log(`Summary belum dapat dibaca: ${response.error}`, 'warning');
    return;
  }
  renderSummary(response.data);
  $('openRunBtn').disabled = false;
  $('openReportBtn').disabled = false;
}

async function pickModel(targetId, modelNo) {
  const file = await window.appApi.pickDtm();
  if (file) {
    $(targetId).value = file;
    refreshInputType(modelNo);
  }
}

async function bootstrap() {
  const state = await window.appApi.getState();
  $('appVersion').textContent = `v${state.version || '0.6.0'}`;

  if (state.settings?.rscriptPath) $('rscriptPath').value = state.settings.rscriptPath;
  if (state.settings?.lastConfig) applyConfig(state.settings.lastConfig);

  const env = await window.appApi.detectEnvironment($('rscriptPath').value);
  if (env.found) {
    $('rscriptPath').value = env.rscriptPath;
    setEnvStatus('R terdeteksi', 'success');
    log(`Rscript terdeteksi: ${env.rscriptPath}`, 'success');
  } else {
    setEnvStatus('R belum ditemukan', 'warning');
    log('Rscript belum ditemukan otomatis. Pilih Rscript.exe secara manual.', 'warning');
  }

  refreshInputType(1);
  refreshInputType(2);
}

$('pickRscript').addEventListener('click', async () => {
  const file = await window.appApi.pickRscript();
  if (file) {
    $('rscriptPath').value = file;
    setEnvStatus('R dipilih', 'success');
    await window.appApi.saveSettings({ rscriptPath: file, lastConfig: getConfig() });
  }
});

$('checkEnvironment').addEventListener('click', async () => {
  try {
    setEnvStatus('Memeriksa...', 'warning');
    setProcessState(true);
    setProgress(5, 'Environment check');
    log('Memeriksa R, terra, dan ketersediaan lidR...');

    const result = await window.appApi.checkEnvironment($('rscriptPath').value);
    if (result?.rscriptPath) $('rscriptPath').value = result.rscriptPath;

    setEnvStatus('Environment checked', 'success');
    log('Pemeriksaan environment selesai.', 'success');
  } catch (error) {
    setEnvStatus('Environment gagal', 'error');
    log(error.message || String(error), 'error');
  } finally {
    setProcessState(false);
  }
});

$('pickModel1').addEventListener('click', () => pickModel('model1Dtm', 1));
$('pickModel2').addEventListener('click', () => pickModel('model2Dtm', 2));

$('pickGcp').addEventListener('click', async () => {
  const file = await window.appApi.pickGcp();
  if (file) $('gcpPath').value = file;
});

$('pickOutput').addEventListener('click', async () => {
  const folder = await window.appApi.pickOutputFolder();
  if (folder) $('outputRoot').value = folder;
});

$('validateBtn').addEventListener('click', async () => {
  try {
    setProcessState(true);
    setRunStatus('Validating', 'warning');
    setProgress(5, 'Validasi input');
    log('Menjalankan validasi input raster / point cloud...');

    const result = await window.appApi.validateAnalysis({
      config: getConfig(),
      rscriptPath: $('rscriptPath').value
    });

    if (!result.ok) {
      const errors = result.errors || ['Validasi gagal.'];
      errors.forEach((message) => log(message, 'error'));
      setRunStatus('Validation failed', 'error');
      return;
    }

    if (result.rscriptPath) $('rscriptPath').value = result.rscriptPath;
    setProgress(100, 'Validasi selesai');
    setRunStatus('Input valid', 'success');
    log('Validasi input selesai tanpa error.', 'success');
  } catch (error) {
    setRunStatus('Validation failed', 'error');
    log(error.message || String(error), 'error');
  } finally {
    setProcessState(false);
  }
});

$('runBtn').addEventListener('click', async () => {
  $('resultDashboard').classList.add('hidden');
  currentSummary = null;
  currentRunDir = '';

  setProcessState(true);
  setRunStatus('Running', 'warning');
  setProgress(1, 'Membuat run');
  log('Memulai Comparable DTM R v0.6.0...');

  try {
    const result = await window.appApi.startAnalysis({
      config: getConfig(),
      rscriptPath: $('rscriptPath').value
    });

    if (!result.ok) {
      const errors = result.errors || ['Proses tidak dapat dimulai.'];
      errors.forEach((message) => log(message, 'error'));
      setRunStatus('Failed to start', 'error');
      setProcessState(false);
      return;
    }

    currentRunDir = result.runDir;
    $('openRunBtn').disabled = false;
    log(`Run folder: ${currentRunDir}`, 'success');
  } catch (error) {
    setRunStatus('Failed', 'error');
    setProcessState(false);
    log(error.message || String(error), 'error');
  }
});

$('cancelBtn').addEventListener('click', async () => {
  const result = await window.appApi.cancelAnalysis();
  if (result.ok) {
    setRunStatus('Cancelled', 'warning');
    setProcessState(false);
    log('Proses dibatalkan pengguna.', 'warning');
  }
});

$('openRunBtn').addEventListener('click', async () => {
  if (currentRunDir) await window.appApi.openPath(currentRunDir);
});

$('openReportBtn').addEventListener('click', async () => {
  if (currentRunDir) await window.appApi.openPath(`${currentRunDir}\\report.html`);
});

$('clearLog').addEventListener('click', () => {
  $('logOutput').textContent = 'Log dibersihkan.';
});

window.appApi.onAnalysisEvent(async (event) => {
  if (!event) return;

  if (event.type === 'run-created') {
    currentRunDir = event.runDir || currentRunDir;
    $('openRunBtn').disabled = !currentRunDir;
    log(`Run dibuat: ${event.runDir}`, 'success');
    return;
  }

  if (event.type === 'progress') {
    setProgress(event.percent, event.stage || event.message);
    if (event.message) log(event.message, event.level || 'info');
    return;
  }

  if (event.type === 'log') {
    log(event.message || '', event.level || 'info');
    return;
  }

  if (event.type === 'fatal') {
    setRunStatus('Failed', 'error');
    setProcessState(false);
    log(event.message || 'Fatal error.', 'error');
    return;
  }

  if (event.type === 'process') {
    if (event.status === 'started') {
      setProcessState(true);
      return;
    }

    if (event.status === 'completed') {
      setProcessState(false);
      if (event.mode === 'analysis') {
        setProgress(100, 'Analisis selesai');
        setRunStatus('Completed', 'success');
        log('Analisis selesai.', 'success');
        setTimeout(() => refreshSummary(currentRunDir), 250);
      } else if (event.mode === 'validation') {
        setProgress(100, 'Validasi selesai');
      }
      return;
    }

    if (event.status === 'failed' || event.status === 'error') {
      setProcessState(false);
      setRunStatus('Failed', 'error');
      if (event.message) log(event.message, 'error');
      if (event.stderr) log(event.stderr, 'error');
      return;
    }

    if (event.status === 'cancelled') {
      setProcessState(false);
      setRunStatus('Cancelled', 'warning');
    }
  }
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((x) => x.classList.remove('active'));
    item.classList.add('active');
  });
});

bootstrap().catch((error) => log(`Bootstrap error: ${error.message || error}`, 'error'));
