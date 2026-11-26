const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    applyRunes: (runeData) => ipcRenderer.invoke('apply-runes', runeData),
    applyItems: (itemIds) => ipcRenderer.invoke('apply-items', itemIds)
});

contextBridge.exposeInMainWorld('danmaku', {
    connect: (roomId) => ipcRenderer.invoke('danmaku-connect', roomId),
    disconnect: () => ipcRenderer.invoke('danmaku-disconnect'),
    setConfig: (config) => ipcRenderer.invoke('danmaku-config', config),
    qrGenerate: () => ipcRenderer.invoke('danmaku-qr-generate'),
    qrPoll: (qrcodeKey) => ipcRenderer.invoke('danmaku-qr-poll', qrcodeKey),
    startVote: (durationSec) => ipcRenderer.invoke('danmaku-vote-start', durationSec),
    onStatus: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('danmaku-status', handler);
        return () => ipcRenderer.removeListener('danmaku-status', handler);
    },
    onMessage: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('danmaku-message', handler);
        return () => ipcRenderer.removeListener('danmaku-message', handler);
    },
    onVoteStart: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('danmaku-vote-start', handler);
        return () => ipcRenderer.removeListener('danmaku-vote-start', handler);
    },
    onVoteUpdate: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('danmaku-vote-update', handler);
        return () => ipcRenderer.removeListener('danmaku-vote-update', handler);
    },
    onVoteEnd: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('danmaku-vote-end', handler);
        return () => ipcRenderer.removeListener('danmaku-vote-end', handler);
    },
    onAction: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('danmaku-action', handler);
        return () => ipcRenderer.removeListener('danmaku-action', handler);
    },
    onDiagnostic: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('danmaku-diagnostic', handler);
        return () => ipcRenderer.removeListener('danmaku-diagnostic', handler);
    },
    onAuth: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('danmaku-auth', handler);
        return () => ipcRenderer.removeListener('danmaku-auth', handler);
    }
});

contextBridge.exposeInMainWorld('updates', {
    getState: () => ipcRenderer.invoke('update:get-state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    dismiss: (version) => ipcRenderer.invoke('update:dismiss', version),
    openRelease: () => ipcRenderer.invoke('update:open-release'),
    onState: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('update:state', handler);
        return () => ipcRenderer.removeListener('update:state', handler);
    }
});
