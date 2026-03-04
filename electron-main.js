const { app, BrowserWindow, dialog, shell } = require("electron");
const { startServer, stopServer } = require("./src/server");

let mainWindow = null;
let serverHandle = null;
let isQuitting = false;

async function createMainWindow() {
  serverHandle = await startServer({
    host: "127.0.0.1",
    port: 0,
    preferencesDir: app.getPath("userData"),
    silent: true
  });

  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#10131a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const localOrigin = new URL(serverHandle.url).origin;

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === "string" && !url.startsWith(localOrigin)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (typeof url === "string" && !url.startsWith(localOrigin)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(serverHandle.url);
}

async function shutdownServer() {
  if (!serverHandle?.server) {
    return;
  }

  const serverRef = serverHandle.server;
  serverHandle = null;
  await stopServer(serverRef);
}

app.whenReady().then(async () => {
  try {
    await createMainWindow();
  } catch (error) {
    const message = error?.message || String(error);
    dialog.showErrorBox("Startup failed", `The local server could not start.\n\n${message}`);
    await shutdownServer();
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) {
    try {
      await createMainWindow();
    } catch (_err) {
      app.quit();
    }
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", async () => {
  await shutdownServer();
});
