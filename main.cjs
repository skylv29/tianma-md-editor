const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let currentFilePath = null; // 记录当前打开的文件路径

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    title: '天马MD编辑器',
    backgroundColor: '#f5f5f4',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // 使用 Electron 原生的 app.isPackaged 判断环境，彻底告别 electron-is-dev 报错
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
    
    // 💡 调试神器：如果以后打包再遇到白屏，把下面这行代码前面的 "//" 删掉重新打包
    // 软件启动时就会自动打开开发者工具，告诉你具体是哪里报错了！
    // mainWindow.webContents.openDevTools(); 
  }

  // 双击 .md / .txt 文件启动时，内容传给渲染进程
  mainWindow.webContents.on('did-finish-load', () => {
    const filePath = process.argv.find(
      (arg) => arg.endsWith('.md') || arg.endsWith('.txt')
    );
    if (filePath && fs.existsSync(filePath)) {
      currentFilePath = filePath;
      const content = fs.readFileSync(filePath, 'utf-8');
      mainWindow.webContents.send('init-file', { content, filePath });
      updateTitle(path.basename(filePath), false);
    }
  });

  // 关闭前询问是否保存（由渲染进程回调触发）
  mainWindow.on('close', (e) => {
    if (mainWindow) {
      e.preventDefault();
      mainWindow.webContents.send('request-close-check');
    }
  });
}

// 更新标题栏：文件名 + 脏状态标记
function updateTitle(fileName, isDirty) {
  const dirty = isDirty ? ' ·' : '';
  if (mainWindow) {
    mainWindow.setTitle(fileName ? `${fileName}${dirty} — 天马MD编辑器` : '天马MD编辑器');
  }
}

// ── IPC 处理 ──────────────────────────────────────────────

// 打开文件
ipcMain.handle('file-open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown / 文本', extensions: ['md', 'txt'] }],
  });
  if (canceled) return null;
  currentFilePath = filePaths[0];
  const content = fs.readFileSync(currentFilePath, 'utf-8');
  updateTitle(path.basename(currentFilePath), false);
  return { content, filePath: currentFilePath };
});

// 保存（覆盖当前文件；若无路径则触发另存为）
ipcMain.handle('file-save', async (event, content) => {
  if (currentFilePath) {
    fs.writeFileSync(currentFilePath, content, 'utf-8');
    updateTitle(path.basename(currentFilePath), false);
    return { saved: true, filePath: currentFilePath };
  }
  // 如果没有当前路径，直接触发另存为逻辑
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, content, 'utf-8');
  currentFilePath = filePath;
  updateTitle(path.basename(filePath), false);
  return { saved: true, filePath };
});

// 另存为
ipcMain.handle('file-save-as', async (event, content) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, content, 'utf-8');
  currentFilePath = filePath;
  updateTitle(path.basename(filePath), false);
  return { saved: true, filePath };
});

// 渲染进程同步脏状态到标题栏
ipcMain.on('set-dirty', (event, { fileName, isDirty }) => {
  updateTitle(fileName, isDirty);
});

// 渲染进程确认可以关闭
ipcMain.on('confirm-close', () => {
  if (mainWindow) {
    mainWindow.destroy();
  }
});

// ─────────────────────────────────────────────────────────
app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});