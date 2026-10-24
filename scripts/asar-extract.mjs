// 从 asar 抽取指定文件的行区间（只读探查用）
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

const [asarPath, innerPath, outPath] = process.argv.slice(2)
const fd = readFileSync(asarPath)
const jsonLen = fd.readUInt32LE(12)
const header = JSON.parse(fd.subarray(16, 16 + jsonLen).toString('utf8'))
const dataStart = 8 + fd.readUInt32LE(4)

let node = header
for (const seg of innerPath.split('/').filter(Boolean)) {
  node = node.files?.[seg]
  if (!node) throw new Error(`not found: ${seg}`)
}
const start = dataStart + Number(node.offset)
const content = fd.subarray(start, start + node.size).toString('utf8')
await writeFile(outPath, content, 'utf8')
console.log(`extracted ${node.size}b -> ${outPath}`)