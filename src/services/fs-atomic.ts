// 原子写（与 App 的 src/main/fsutil/atomic.ts 同语义）：
// 同目录临时文件 + rename；Windows 目标被占用（EBUSY/EPERM）时先把旧文件挪成 .bak，
// 再落新文件——绝不先删旧文件，避免 rm 与 rename 之间崩溃把原文件丢掉。
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function atomicWriteSync(target: string, content: string): void {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(target)}.${process.pid}.tmp`)
  writeFileSync(tmp, content, 'utf8')
  try {
    try {
      renameSync(tmp, target)
    } catch (error) {
      const bak = `${target}.bak`
      try {
        renameSync(target, bak)
      } catch {
        throw error
      }
      renameSync(tmp, target)
      rmSync(bak, { force: true })
    }
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

/** 启动恢复：崩溃停在「旧文件已挪成 .bak、新文件未落位」之间时，把旧版还原 */
export function recoverAtomicBackupSync(target: string): void {
  const bak = `${target}.bak`
  if (!existsSync(bak)) return
  if (existsSync(target)) {
    rmSync(bak, { force: true })
  } else {
    renameSync(bak, target)
  }
}