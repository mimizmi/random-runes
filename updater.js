'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_REPO = 'mimizmi/random-runes';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROD_DOWNLOAD_HOSTS = new Set([
    'github.com',
    'api.github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com'
]);

function normalizeVersion(raw) {
    return String(raw || '').trim().replace(/^v/i, '');
}

function parseVersion(raw) {
    const text = normalizeVersion(raw);
    const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        pre: match[4] || ''
    };
}

function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return 0;
    for (const key of ['major', 'minor', 'patch']) {
        if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
    }
    if (a.pre === b.pre) return 0;
    if (!a.pre) return 1;
    if (!b.pre) return -1;
    return a.pre > b.pre ? 1 : -1;
}

function pickUpdateAsset(release) {
    const assets = release && Array.isArray(release.assets) ? release.assets : [];
    const zips = assets.filter((asset) => {
        if (!asset || typeof asset.browser_download_url !== 'string') return false;
        return /\.zip$/i.test(String(asset.name || ''));
    });
    return zips.find((asset) => /win/i.test(String(asset.name || ''))) || zips[0] || null;
}

function parseDigest(raw) {
    const match = String(raw || '').trim().match(/^(?:sha256:)?([a-f0-9]{64})$/i);
    return match ? match[1].toLowerCase() : '';
}

function truncateText(raw, limit) {
    const text = String(raw || '').trim();
    if (!text) return '';
    return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

function requestUrl(url, options = {}) {
    const { headers = {}, timeoutMs = 10000, allowHttp = false, maxBytes = 2 * 1024 * 1024 } = options;
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            reject(new Error('更新地址无效'));
            return;
        }
        const isHttp = parsed.protocol === 'http:';
        if (parsed.protocol !== 'https:' && !(allowHttp && isHttp)) {
            reject(new Error('更新地址必须使用 HTTPS'));
            return;
        }
        const client = isHttp ? http : https;
        const req = client.get(parsed, { headers }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    req.destroy(new Error('更新服务响应过大'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    });
}

async function requestJson(url, options = {}) {
    const response = await requestUrl(url, options);
    if (response.statusCode === 404) return null;
    if (response.statusCode === 403 || response.statusCode === 429) {
        const err = new Error('GitHub 请求过于频繁，请稍后再试');
        err.code = 'RATE_LIMIT';
        throw err;
    }
    if (response.statusCode !== 200) {
        throw new Error(`更新服务返回 HTTP ${response.statusCode}`);
    }
    try {
        return JSON.parse(response.body.toString('utf8'));
    } catch {
        throw new Error('更新服务返回了无效数据');
    }
}

function isAllowedDownloadHost(hostname, allowHttp) {
    const host = String(hostname || '').toLowerCase();
    if (allowHttp && (host === '127.0.0.1' || host === 'localhost')) return true;
    if (PROD_DOWNLOAD_HOSTS.has(host)) return true;
    return host.endsWith('.githubusercontent.com');
}

function downloadFile(url, dest, options = {}) {
    const { onProgress, timeoutMs = 60000, allowHttp = false } = options;
    const partPath = `${dest}.part`;
    return new Promise((resolve, reject) => {
        let settled = false;
        let output = null;

        const fail = (error) => {
            if (settled) return;
            settled = true;
            if (output) {
                try { output.destroy(); } catch { /* ignore */ }
            }
            try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
            reject(error);
        };

        const start = (currentUrl, redirects = 0) => {
            if (redirects > 8) {
                fail(new Error('更新包下载跳转次数过多'));
                return;
            }
            let parsed;
            try {
                parsed = new URL(currentUrl);
            } catch {
                fail(new Error('更新包下载地址无效'));
                return;
            }
            const isHttp = parsed.protocol === 'http:';
            if (parsed.protocol !== 'https:' && !(allowHttp && isHttp)) {
                fail(new Error('更新包下载地址必须使用 HTTPS'));
                return;
            }
            if (!isAllowedDownloadHost(parsed.hostname, allowHttp)) {
                fail(new Error('更新包下载地址不在允许范围内'));
                return;
            }
            const client = isHttp ? http : https;
            const req = client.get(parsed, {
                headers: { 'User-Agent': 'random-runes-updater' }
            }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const location = res.headers.location;
                    res.resume();
                    if (!location) {
                        fail(new Error('更新包下载跳转缺少地址'));
                        return;
                    }
                    start(new URL(location, parsed).toString(), redirects + 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    fail(new Error(`更新包下载失败（HTTP ${res.statusCode}）`));
                    return;
                }
                const total = Number(res.headers['content-length']) || 0;
                const hash = crypto.createHash('sha256');
                let received = 0;
                output = fs.createWriteStream(partPath);
                res.on('data', (chunk) => {
                    received += chunk.length;
                    hash.update(chunk);
                    if (onProgress) {
                        onProgress({
                            received,
                            total,
                            percent: total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null
                        });
                    }
                });
                res.on('error', fail);
                output.on('error', fail);
                output.on('finish', () => {
                    if (settled) return;
                    settled = true;
                    try {
                        fs.rmSync(dest, { force: true });
                        fs.renameSync(partPath, dest);
                    } catch (error) {
                        fail(error);
                        return;
                    }
                    resolve({ bytes: received, sha256: hash.digest('hex') });
                });
                res.pipe(output);
            });
            req.on('error', fail);
            req.setTimeout(timeoutMs, () => req.destroy(new Error('更新包下载超时')));
        };

        start(url);
    });
}

function psQuote(value) {
    return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

function buildInstallerScript(config = {}) {
    const waitPid = Number(config.waitPid) || 0;
    const skipRestart = config.skipRestart ? '$true' : '$false';
    return String.raw`$WaitPid = ${waitPid}
$ZipPath = ${psQuote(config.zipPath)}
$DestDir = ${psQuote(config.installDir)}
$ExeName = ${psQuote(config.exeName)}
$LogPath = ${psQuote(config.logPath)}
$LauncherPath = ${psQuote(config.launcherPath)}
$SkipRestart = ${skipRestart}

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
    try {
        Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
    } catch { }
}

function Show-Error([string]$Message) {
    try {
        Add-Type -AssemblyName PresentationFramework
        $newLine = [Environment]::NewLine
        $text = '自动更新失败：' + $newLine + $Message + $newLine + $newLine + '请前往 GitHub Releases 手动下载最新版。'
        [System.Windows.MessageBox]::Show($text, 'Random Runes 更新失败', 'OK', 'Error') | Out-Null
    } catch { }
}

$exitCode = 0
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Write-Log ("start pid=$PID session=" + [System.Diagnostics.Process]::GetCurrentProcess().SessionId + " admin=$isAdmin user=" + $identity.Name)
    Write-Log "waiting for process $WaitPid"
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
        Start-Sleep -Milliseconds 250
    }
    Start-Sleep -Seconds 1

    $extractDir = Join-Path $env:TEMP ("random-runes-extract-" + [guid]::NewGuid().ToString('N'))
    Write-Log "extracting $ZipPath -> $extractDir"
    # Expand-Archive in Windows PowerShell 5.1 can fail with an overload error;
    # use the .NET ZipFile API directly.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $extractDir)

    $exe = Get-ChildItem -LiteralPath $extractDir -Filter $ExeName -Recurse -File | Select-Object -First 1
    if (-not $exe) { throw "更新包中未找到 $ExeName" }
    $sourceDir = $exe.Directory.FullName
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'resources\app.asar'))) {
        throw '更新包结构不正确（缺少 resources\app.asar）'
    }

    Write-Log "copying $sourceDir -> $DestDir"
    & robocopy $sourceDir $DestDir /E /IS /R:3 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    $robocopyCode = $LASTEXITCODE
    Write-Log "robocopy exit $robocopyCode"
    if ($robocopyCode -ge 8) { throw "复制更新文件失败（robocopy $robocopyCode）" }

    $newExe = Join-Path $DestDir $ExeName
    if ($SkipRestart) {
        Write-Log 'restart skipped by test flag'
    } else {
        Write-Log "restarting $newExe"
        if ($isAdmin) {
            Start-Process -FilePath $newExe -WorkingDirectory $DestDir
        } else {
            Start-Process -FilePath $newExe -WorkingDirectory $DestDir -Verb RunAs
        }
    }
    Write-Log 'update finished'

    Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
} catch {
    $exitCode = 1
    Write-Log ("ERROR: " + $_.Exception.Message)
    Show-Error $_.Exception.Message
} finally {
    Start-Sleep -Seconds 1
    Remove-Item -LiteralPath $LauncherPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
exit $exitCode
`;
}

function buildLauncherScript(config = {}) {
    return String.raw`$InstallerPath = ${psQuote(config.installerPath)}
$LauncherLog = ${psQuote(config.launcherLog)}

function Write-LauncherLog([string]$Message) {
    try {
        Add-Content -LiteralPath $LauncherLog -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
    } catch { }
}

try {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $cmd = '"' + $ps + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $InstallerPath + '"'
    Write-LauncherLog ("wmi create: " + $cmd)
    # WMI-created processes run outside Electron's job object, so the helper
    # survives after the app exits and can replace the running executable.
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
    Write-LauncherLog ("wmi return=" + $r.ReturnValue + " pid=" + $r.ProcessId)
    if ($r.ReturnValue -ne 0) { exit 1 }
    exit 0
} catch {
    Write-LauncherLog ("ERROR: " + $_.Exception.Message)
    exit 1
}
`;
}

function writeUpdateScripts(dir, config = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const installerPath = path.join(dir, `install-${stamp}.ps1`);
    const launcherPath = path.join(dir, `launch-${stamp}.ps1`);
    const launcherLog = path.join(dir, `launcher-${stamp}.log`);
    const full = { ...config, installerPath, launcherPath, launcherLog };
    // BOM keeps Chinese messages readable under Windows PowerShell 5.1.
    fs.writeFileSync(installerPath, `\uFEFF${buildInstallerScript(full)}`, 'utf8');
    fs.writeFileSync(launcherPath, `\uFEFF${buildLauncherScript(full)}`, 'utf8');
    return { installerPath, launcherPath, launcherLog };
}

function defaultInstallRunner({ launcherPath, launcherLog, timeoutMs = 15000 }) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(powershell, [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden',
            '-File', launcherPath
        ], {
            stdio: 'ignore',
            windowsHide: true
        });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill(); } catch { /* ignore */ }
            reject(new Error('启动更新助手超时'));
        }, timeoutMs);
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve();
                return;
            }
            let detail = '';
            try {
                const lines = fs.readFileSync(launcherLog, 'utf8').trim().split(/\r?\n/);
                detail = lines.slice(-3).join(' | ');
            } catch { /* ignore */ }
            reject(new Error(`启动更新助手失败（退出码 ${code}）${detail ? `：${detail}` : ''}`));
        });
    });
}

function isUnderDirectory(child, parent) {
    const a = path.resolve(child).toLowerCase();
    const b = path.resolve(parent).toLowerCase();
    return a === b || a.startsWith(`${b}${path.sep}`);
}

function createUpdater(options) {
    const {
        app,
        ipcMain,
        shell,
        send,
        repo = DEFAULT_REPO,
        feedBase,
        installRunner = defaultInstallRunner,
        quitAfterInstall = true
    } = options;

    const currentVersion = normalizeVersion(app.getVersion() || '0.0.0');
    const feed = String(feedBase || process.env.RANDOM_RUNES_UPDATE_FEED || 'https://api.github.com').replace(/\/+$/, '');
    const allowHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(feed);
    const installDir = path.dirname(app.getPath('exe'));
    const exeName = path.basename(app.getPath('exe'));
    const tempRoot = path.join(app.getPath('temp'), 'random-runes-update');
    const logPath = path.join(app.getPath('temp'), 'random-runes-update.log');
    const statePath = path.join(app.getPath('userData'), 'update-state.json');
    const canAutoUpdate = app.isPackaged === true
        && process.platform === 'win32'
        && !isUnderDirectory(installDir, app.getPath('temp'));

    let state = {
        status: 'idle',
        currentVersion,
        latestVersion: '',
        releaseName: '',
        releaseUrl: '',
        notes: '',
        publishedAt: '',
        assetName: '',
        assetSize: 0,
        assetUrl: '',
        digest: '',
        progress: null,
        error: '',
        dismissed: false,
        checkedAt: 0,
        manual: false,
        canAutoUpdate
    };
    let busy = null;
    let installPromise = null;
    let initialized = false;

    function setState(patch) {
        state = { ...state, ...patch };
        if (typeof send === 'function') {
            try { send('update:state', state); } catch { /* renderer may be gone */ }
        }
        return state;
    }

    function readDismissedVersion() {
        try {
            const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            return normalizeVersion(raw && raw.dismissedVersion);
        } catch {
            return '';
        }
    }

    function writeDismissedVersion(version) {
        try {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            const tmp = `${statePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ dismissedVersion: version }, null, 2), 'utf8');
            fs.renameSync(tmp, statePath);
        } catch { /* non-fatal */ }
    }

    function humanizeError(error) {
        const message = error && error.message ? error.message : String(error);
        if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|socket hang up|network|timeout/i.test(message)) {
            return '网络连接失败，请检查网络后重试';
        }
        if (/rate limit|403|429/i.test(message)) {
            return 'GitHub 请求过于频繁，请稍后再试';
        }
        return message;
    }

    async function fetchLatestRelease() {
        const url = `${feed}/repos/${repo}/releases/latest`;
        return requestJson(url, {
            headers: {
                'User-Agent': `random-runes/${currentVersion}`,
                'Accept': 'application/vnd.github+json'
            },
            allowHttp,
            timeoutMs: 10000
        });
    }

    async function check(manual = false) {
        if (busy) return state;
        busy = 'check';
        setState({ status: 'checking', error: '', manual: !!manual });
        try {
            const release = await fetchLatestRelease();
            if (!release || !release.tag_name) {
                return setState({
                    status: 'up-to-date',
                    latestVersion: currentVersion,
                    checkedAt: Date.now(),
                    manual: !!manual
                });
            }
            const latestVersion = normalizeVersion(release.tag_name);
            const asset = pickUpdateAsset(release);
            const dismissed = !manual && readDismissedVersion() === latestVersion;
            const info = {
                latestVersion,
                releaseName: String(release.name || latestVersion),
                releaseUrl: String(release.html_url || `https://github.com/${repo}/releases/latest`),
                notes: truncateText(release.body, 4000),
                publishedAt: String(release.published_at || ''),
                assetName: asset ? String(asset.name || '') : '',
                assetSize: asset ? Number(asset.size) || 0 : 0,
                assetUrl: asset ? String(asset.browser_download_url || '') : '',
                digest: asset ? String(asset.digest || '') : '',
                checkedAt: Date.now(),
                manual: !!manual,
                dismissed
            };
            if (compareVersions(latestVersion, currentVersion) > 0) {
                if (!asset) {
                    return setState({
                        ...info,
                        status: 'error',
                        error: '该版本没有可用的 Windows 更新包'
                    });
                }
                return setState({ ...info, status: 'available', error: '', progress: null });
            }
            return setState({
                ...info,
                status: 'up-to-date',
                error: '',
                progress: null,
                dismissed: false
            });
        } catch (error) {
            return setState({
                status: 'error',
                error: humanizeError(error),
                manual: !!manual,
                progress: null
            });
        } finally {
            busy = null;
        }
    }

    async function runInstall() {
        if (busy) return;
        if (!canAutoUpdate) {
            setState({
                status: 'error',
                error: '当前运行方式不支持一键更新，请前往发布页手动下载。'
            });
            return;
        }
        if (state.status !== 'available' || !state.assetUrl) {
            const checked = await check(false);
            if (checked.status !== 'available') return;
        }

        busy = 'install';
        const assetUrl = state.assetUrl;
        const assetName = path.basename(state.assetName || `random-runes-${state.latestVersion}-win.zip`);
        const zipPath = path.join(tempRoot, assetName);
        const expectedSha = parseDigest(state.digest);
        try {
            fs.mkdirSync(tempRoot, { recursive: true });
            try { fs.rmSync(logPath, { force: true }); } catch { /* ignore */ }
            setState({
                status: 'downloading',
                error: '',
                progress: { received: 0, total: state.assetSize || 0, percent: 0 }
            });

            let lastProgressAt = 0;
            const result = await downloadFile(assetUrl, zipPath, {
                allowHttp,
                onProgress: (progress) => {
                    const now = Date.now();
                    if (now - lastProgressAt >= 200 || progress.percent === 100) {
                        lastProgressAt = now;
                        setState({ progress });
                    }
                }
            });

            if (expectedSha && result.sha256.toLowerCase() !== expectedSha) {
                throw new Error('更新包校验失败，已取消安装');
            }

            setState({
                status: 'installing',
                progress: {
                    received: result.bytes,
                    total: result.bytes,
                    percent: 100
                }
            });

            const scripts = writeUpdateScripts(tempRoot, {
                waitPid: process.pid,
                zipPath,
                installDir,
                exeName,
                logPath,
                // Test-only escape hatch: verifies the copy path without a UAC restart.
                skipRestart: process.env.RANDOM_RUNES_UPDATE_SKIP_RESTART === '1'
            });
            await installRunner({ ...scripts, installDir, exeName, timeoutMs: 15000 });

            if (quitAfterInstall) {
                setTimeout(() => {
                    try { app.quit(); } catch { /* ignore */ }
                }, 500);
            }
        } catch (error) {
            try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
            setState({
                status: 'error',
                error: humanizeError(error),
                progress: null
            });
        } finally {
            busy = null;
        }
    }

    function install() {
        if (installPromise) return state;
        installPromise = runInstall().finally(() => {
            installPromise = null;
        });
        return state;
    }

    function dismiss(version) {
        const target = normalizeVersion(version || state.latestVersion);
        if (!target) return state;
        writeDismissedVersion(target);
        return setState({ dismissed: true });
    }

    function openRelease() {
        const url = state.releaseUrl || `https://github.com/${repo}/releases/latest`;
        try { shell.openExternal(url); } catch { /* ignore */ }
        return { success: true, url };
    }

    function init() {
        if (initialized) return;
        initialized = true;
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        ipcMain.handle('update:get-state', () => state);
        ipcMain.handle('update:check', () => check(true));
        ipcMain.handle('update:install', () => install());
        ipcMain.handle('update:dismiss', (_event, version) => dismiss(version));
        ipcMain.handle('update:open-release', () => openRelease());
    }

    function startAutoCheck() {
        if (app.isPackaged !== true) return;
        const firstTimer = setTimeout(() => {
            check(false).catch(() => {});
        }, 5000);
        const interval = setInterval(() => {
            check(false).catch(() => {});
        }, CHECK_INTERVAL_MS);
        if (firstTimer.unref) firstTimer.unref();
        if (interval.unref) interval.unref();
    }

    return {
        init,
        check,
        install,
        dismiss,
        openRelease,
        startAutoCheck,
        getState: () => state
    };
}

module.exports = {
    DEFAULT_REPO,
    CHECK_INTERVAL_MS,
    normalizeVersion,
    parseVersion,
    compareVersions,
    pickUpdateAsset,
    parseDigest,
    truncateText,
    requestUrl,
    requestJson,
    downloadFile,
    psQuote,
    buildInstallerScript,
    buildLauncherScript,
    writeUpdateScripts,
    defaultInstallRunner,
    createUpdater
};
