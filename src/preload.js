const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appApi', {
  pickDtm: () => ipcRenderer.invoke('dialog:dtm'),
  pickGcp: () => ipcRenderer.invoke('dialog:gcp'),
  pickRscript: () => ipcRenderer.invoke('dialog:rscript'),
  pickOutputFolder: () => ipcRenderer.invoke('dialog:outputFolder'),

  getState: () => ipcRenderer.invoke('app:getState'),
  saveSettings: (settings) => ipcRenderer.invoke('app:saveSettings', settings),

  detectEnvironment: (requestedPath) => ipcRenderer.invoke('environment:detect', requestedPath),
  checkEnvironment: (requestedPath) => ipcRenderer.invoke('environment:check', requestedPath),

  validateAnalysis: (payload) => ipcRenderer.invoke('analysis:validate', payload),
  startAnalysis: (payload) => ipcRenderer.invoke('analysis:start', payload),
  cancelAnalysis: () => ipcRenderer.invoke('analysis:cancel'),

  readSummary: (runDir) => ipcRenderer.invoke('result:readSummary', runDir),

  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),
  showItem: (targetPath) => ipcRenderer.invoke('shell:showItem', targetPath),

  onAnalysisEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('analysis:event', handler);
    return () => ipcRenderer.removeListener('analysis:event', handler);
  }
});
