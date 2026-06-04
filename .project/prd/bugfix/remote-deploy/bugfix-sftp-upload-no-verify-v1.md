# PRD [Bugfix级] -- 离线部署 SFTP 上传无校验导致解压失败

> 版本：bugfix-sftp-upload-no-verify-v1
> 日期：2026-06-04
> 指令人：用户
> 归属模块：modules/remote-agent/remote-deploy
> 状态：in-progress
> 级别：bugfix
> 优先级：P0
> 影响范围：全栈

---

## 需求分析 / 根因

### 现象

离线部署（Offline Deploy）将 ~44MB 的 tar.xz 离线包通过 SFTP 上传到远程服务器后，解压阶段频繁失败，报错信息：

```
xz: Compressed data is corrupt
tar: Unexpected EOF in archive
```

### 根因

在 `src/main/services/remote/ssh/ssh-manager.ts` 第 407-428 行，`uploadFile` 方法使用 `ssh2` 库的 `fastPut` 上传文件，但上传完成后**没有校验远端文件大小或校验和**。对于大文件（~44MB），文件可能在传输过程中被静默截断（磁盘空间不足、网络连接中断、SFTP 缓冲区溢出等），而代码继续执行后续的解压操作，导致解压失败。

具体问题链：

1. **`ssh-manager.ts` 第 407-428 行**：`uploadFile` 调用 `sftp.fastPut()` 后直接 resolve，无任何文件完整性校验。
2. **`agent-deployer.ts` 第 743 行**：远端路径硬编码为 `aico-bot-offline.tar.gz`，无论实际格式是 `.tar.gz` 还是 `.tar.xz`（仅影响文件名，不直接影响此 bug）。
3. **`agent-deployer.ts` 第 744 行**：`await manager.uploadFile(bundlePath, remoteBundlePath)` 调用后无校验，直接进入解压流程。
4. **`agent-deployer.ts` 第 753-756 行**：`file` 命令能正确检测格式并选择正确的解压参数，但由于文件已被截断，解压必然失败。
5. **无磁盘空间预检**：上传前不检查远端剩余磁盘空间，导致磁盘满时上传静默截断。

### 影响范围

- 所有使用离线部署功能的用户
- 网络不稳定或远端磁盘空间不足时必现
- 失败后需要重新执行完整部署流程，用户体验极差

---

## 技术方案

### 方案概述

在 SFTP 上传流程中增加三层防护：

1. **上传前磁盘空间预检**：上传前检查远端磁盘剩余空间，给出明确的磁盘不足错误提示。
2. **上传后文件大小校验 + 重试**：上传完成后比对本地和远端文件大小，不一致时自动重试（最多 3 次，指数退避）。
3. **大文件分块上传**：对 >10MB 的文件使用流式分块上传（`createReadStream` → `createWriteStream` pipe），避免 `fastPut` 将整个文件加载到内存的问题。

### 变更 1：`ssh-manager.ts` — 新增 `stat` 方法

在第 428 行（`uploadFile` 方法之后）新增：

```typescript
/**
 * Get file stats on the remote server via SFTP.
 * Returns { size } for file size verification.
 */
async stat(remotePath: string): Promise<{ size: number; mode: number; mtime: number }> {
  return this.withLock(async () => {
    await this.initSFTP();

    return new Promise((resolve, reject) => {
      this.sftp!.stat(remotePath, (err, stats) => {
        if (err) {
          reject(new Error(`SFTP stat failed for ${remotePath}: ${err.message}`));
        } else {
          resolve({
            size: stats.size,
            mode: stats.mode,
            mtime: stats.mtime,
          });
        }
      });
    });
  });
}
```

### 变更 2：`ssh-manager.ts` — 新增 `uploadFileChunked` 方法

在 `stat` 方法之后新增：

```typescript
/**
 * Upload a large file using chunked stream transfer.
 * More reliable than fastPut for files > 10MB.
 * Reports progress via onProgress callback (bytes transferred).
 */
async uploadFileChunked(
  localPath: string,
  remotePath: string,
  onProgress?: (transferred: number, total: number) => void,
): Promise<void> {
  return this.withLock(async () => {
    await this.initSFTP();

    const localStat = fs.statSync(localPath);
    const totalSize = localStat.size;

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(localPath, { highWaterMark: 64 * 1024 });
      const writeStream = this.sftp!.createWriteStream(remotePath, { mode: 0o644 });

      let transferred = 0;

      writeStream.on('close', () => {
        console.log(`[SSHManager] Chunked upload completed: ${remotePath}`);
        resolve();
      });

      writeStream.on('error', (err: Error) => {
        console.error(`[SSHManager] Chunked upload write error:`, err);
        readStream.destroy();
        reject(err);
      });

      readStream.on('error', (err: Error) => {
        console.error(`[SSHManager] Chunked upload read error:`, err);
        writeStream.destroy();
        reject(err);
      });

      readStream.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        onProgress?.(transferred, totalSize);
      });

      readStream.pipe(writeStream);
    });
  });
}
```

需要在文件顶部增加 `import * as fs from 'fs';`（当前文件未引入 `fs`）。

### 变更 3：`ssh-manager.ts` — 改造 `uploadFile` 方法

修改第 407-428 行的 `uploadFile`，增加智能选择上传策略（小文件用 `fastPut`，大文件用流式分块）：

```typescript
/**
 * Upload a file to the remote server.
 * Automatically uses chunked upload for files > 10MB.
 */
async uploadFile(localPath: string, remotePath: string): Promise<void> {
  const localStat = fs.statSync(localPath);
  const fileSize = localStat.size;
  const CHUNKED_THRESHOLD = 10 * 1024 * 1024; // 10MB

  if (fileSize > CHUNKED_THRESHOLD) {
    console.log(`[SSHManager] Large file (${(fileSize / 1024 / 1024).toFixed(1)}MB), using chunked upload`);
    return this.uploadFileChunked(localPath, remotePath);
  }

  // Small files: use fastPut (original behavior)
  return this.withLock(async () => {
    await this.initSFTP();
    console.log(`[SSHManager] Uploading ${localPath} to ${remotePath}`);
    return new Promise((resolve, reject) => {
      const fastPut = promisify(this.sftp!.fastPut);
      fastPut
        .call(this.sftp!, localPath, remotePath)
        .then(() => {
          console.log(`[SSHManager] Upload completed`);
          resolve();
        })
        .catch((err) => {
          console.error('[SSHManager] Upload error:', err);
          reject(err);
        });
    });
  });
}
```

### 变更 4：`agent-deployer.ts` — 新增 `uploadWithVerify` 辅助函数

在文件顶部（`computeMd5` 之后约第 169 行）新增辅助函数：

```typescript
/**
 * Upload a file with post-upload size verification and automatic retry.
 * - Checks remote disk space before upload
 * - Compares local and remote file sizes after upload
 * - Retries up to maxRetries times with exponential backoff on mismatch
 */
async function uploadWithVerify(
  manager: any, // SSHManager
  localPath: string,
  remotePath: string,
  options?: {
    maxRetries?: number;
    onAttempt?: (attempt: number, maxRetries: number) => void;
  },
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 3;
  const localStat = fs.statSync(localPath);
  const localSize = localStat.size;

  // Pre-upload: check remote disk space
  const requiredSpace = localSize + 100 * 1024 * 1024; // extra 100MB buffer
  const dfResult = await manager.executeCommandFull(
    `df -B1 $(dirname ${remotePath}) 2>/dev/null | tail -1 | awk '{print $4}'`,
  );
  const availableSpace = parseInt(dfResult.stdout.trim(), 10);
  if (!isNaN(availableSpace) && availableSpace < requiredSpace) {
    throw new Error(
      `远端磁盘空间不足: 需要 ${(requiredSpace / 1024 / 1024).toFixed(0)}MB, 可用 ${(availableSpace / 1024 / 1024).toFixed(0)}MB`,
    );
  }

  // Upload with retry
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    options?.onAttempt?.(attempt, maxRetries);

    await manager.uploadFile(localPath, remotePath);

    // Post-upload: verify file size
    let remoteSize: number;
    try {
      const statResult = await manager.stat(remotePath);
      remoteSize = statResult.size;
    } catch {
      throw new Error(`上传校验失败: 无法获取远端文件状态 (${remotePath})`);
    }

    if (remoteSize === localSize) {
      console.log(`[uploadWithVerify] Upload verified: local=${localSize}, remote=${remoteSize}`);
      return; // Success
    }

    console.warn(
      `[uploadWithVerify] Size mismatch (attempt ${attempt}/${maxRetries}): local=${localSize}, remote=${remoteSize}`,
    );

    if (attempt < maxRetries) {
      // Exponential backoff: 2s, 4s
      const delayMs = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // All retries exhausted
  throw new Error(
    `上传校验失败: 文件大小不匹配，已重试 ${maxRetries} 次。` +
    `本地: ${localSize} bytes, 远端: 需要再次检查`,
  );
}
```

### 变更 5：`agent-deployer.ts` — 替换 `deployAgentCodeOffline` 中的上传调用

将第 744 行：

```typescript
await manager.uploadFile(bundlePath, remoteBundlePath);
```

替换为：

```typescript
await uploadWithVerify(manager, bundlePath, remoteBundlePath, {
  onAttempt: (attempt, maxRetries) => {
    if (attempt > 1) {
      service.emitCommandOutput(id, 'output', `上传校验失败，第 ${attempt}/${maxRetries} 次重试...`);
    }
  },
});
service.emitCommandOutput(id, 'output', `上传校验通过: ${(fs.statSync(bundlePath).size / 1024 / 1024).toFixed(1)}MB`);
```

### 变更 6：`agent-deployer.ts` — 替换 `updateAgentCode` 中的上传调用

将第 354 行：

```typescript
await updatedManager.uploadFile(packagePath, remotePackagePath);
```

替换为：

```typescript
await uploadWithVerify(updatedManager, packagePath, remotePackagePath);
```

---

## 开发前必读

### 源码文件

| 文件路径 | 阅读目的 |
|---------|---------|
| `src/main/services/remote/ssh/ssh-manager.ts` | 理解 SSH/SFTP 连接管理、`uploadFile` 当前实现、`withLock` 机制 |
| `src/main/services/remote/deploy/agent-deployer.ts` | 理解离线部署流程、`deployAgentCodeOffline` 和 `updateAgentCode` 的上传调用点 |
| `src/main/services/remote/deploy/remote-deploy.service.ts` | 理解 `RemoteDeployService` 的 `emitCommandOutput` / `emitDeployProgress` 接口 |

### 相关依赖

| 依赖 | 说明 |
|------|------|
| `ssh2` (SFTPWrapper) | `sftp.stat()`、`sftp.fastPut()`、`sftp.createReadStream/WriteStream` API |
| Node.js `fs` | `fs.statSync()`、`fs.createReadStream()` |

---

## 涉及文件

### 修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `src/main/services/remote/ssh/ssh-manager.ts` | 1) 顶部新增 `import * as fs from 'fs'`；2) 新增 `stat()` 方法；3) 新增 `uploadFileChunked()` 方法；4) 改造 `uploadFile()` 方法，大文件自动走分块上传 |
| `src/main/services/remote/deploy/agent-deployer.ts` | 1) 新增 `uploadWithVerify()` 辅助函数（磁盘空间预检 + 上传后大小校验 + 重试）；2) `deployAgentCodeOffline` 第 744 行替换为 `uploadWithVerify`；3) `updateAgentCode` 第 354 行替换为 `uploadWithVerify` |

---

## 验收标准

- [ ] **B1**: `ssh-manager.ts` 新增 `stat(remotePath)` 方法，返回 `{ size, mode, mtime }`，通过 `sftp.stat()` 实现
- [ ] **B2**: `ssh-manager.ts` 新增 `uploadFileChunked(localPath, remotePath, onProgress?)` 方法，使用 `createReadStream` + `createWriteStream` + `pipe` 进行流式分块上传
- [ ] **B3**: `uploadFile` 方法自动判断文件大小：>10MB 使用 `uploadFileChunked`，否则使用原有 `fastPut`
- [ ] **B4**: `agent-deployer.ts` 新增 `uploadWithVerify` 函数，上传前检查远端磁盘空间（`df` 命令），空间不足时抛出清晰错误信息
- [ ] **B5**: `uploadWithVerify` 上传后通过 `stat()` 比对本地和远端文件大小，一致才视为成功
- [ ] **B6**: `uploadWithVerify` 大小不匹配时自动重试，最多 3 次，退避间隔 2s/4s，重试时通过 `emitCommandOutput` 通知 UI
- [ ] **B7**: `deployAgentCodeOffline`（第 744 行）和 `updateAgentCode`（第 354 行）的上传调用均替换为 `uploadWithVerify`
- [ ] **B8**: 磁盘空间检查失败时错误信息包含具体数值（需要 XX MB，可用 XX MB）
- [ ] **B9**: 所有重试耗尽后错误信息包含重试次数、本地文件大小
- [ ] **B10**: `npm run typecheck` 无新增错误
- [ ] **B11**: 手动测试：在磁盘空间充裕的服务器上完成一次完整离线部署，验证上传校验通过
- [ ] **B12**: 手动测试：上传校验通过的文件大小与本地一致，解压不再出现 "Compressed data is corrupt" 错误
