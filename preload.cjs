const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件操作
  openFile: () => ipcRenderer.invoke('file-open'),
  saveFile: (content) => ipcRenderer.invoke('file-save', content),
  saveFileAs: (content) => ipcRenderer.invoke('file-save-as', content),

  // 标题栏脏状态同步
  setDirty: (fileName, isDirty) =>
    ipcRenderer.send('set-dirty', { fileName, isDirty }),

  // 关闭前检查（主进程触发，渲染进程响应）
  onRequestCloseCheck: (callback) =>
    ipcRenderer.on('request-close-check', callback),

  // 双击文件打开
  onInitFile: (callback) =>
    ipcRenderer.on('init-file', (event, data) => callback(data)),

  // 确认可以关闭
  confirmClose: () => ipcRenderer.send('confirm-close'),
});
