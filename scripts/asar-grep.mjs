// 迷你 asar 读取器：解析头部 JSON，按 offset 抽取文件内容（只读，A4 契约探查用）
import { readFileSync } from 'node:fs'

const asarPath = process.argv[2]
const pattern = new RegExp(process.argv[3], 'i')

const fd = readFileSync(asarPath)
const jsonLen = fd.readUInt32LE(12)
const header = JSON.parse(fd.subarray(16, 16 + jsonLen).toString('utf8'))
const dataStart = 8 + fd.readUInt32LE(4)

function* walk(node, prefix) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      yield* walk(child, prefix + '/' + name)
    }
  } else if (node.offset !== undefined) {
    yield { path: prefix, offset: node.offset, size: node.size }
  }
}

let matched = 0
for (const f of walk(header, '')) {
  if (!/\.(js|cjs|mjs|json)$/.test(f.path)) continue
  const start = dataStart + Number(f.offset)
  const content = fd.subarray(start, start + f.size).toString('utf8')
  if (pattern.test(content)) {
    matched++
    console.log(`=== ${f.path} (${f.size}b) ===`)
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      if (pattern.test(line)) {
        console.log(`L${i + 1}: ${line.trim().slice(0, 300)}`)
      }
    })
    if (matched >= 8) break
  }
}
console.log(`\nmatched files: ${matched}`)
