import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { readZipEntries } from '../src/main/collectors/ediscoveryExport'

interface Entry {
  name: string
  data: Buffer
  /** Force the ZIP64 encoding for this entry regardless of its size. */
  zip64?: boolean
}

const U32_MAX = 0xffffffff

/**
 * Build a ZIP by hand so the reader can be exercised against both the classic
 * and the ZIP64 encoding without checking multi-gigabyte fixtures into the repo.
 */
function buildZip(entries: Entry[], opts: { zip64Eocd?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const comp = deflateRawSync(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(8, 8) // method: deflate
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, comp)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)

    let extra = Buffer.alloc(0)
    if (entry.zip64) {
      // Saturate compressed size + local header offset, and describe both in a
      // 0x0001 extra field, in the fixed order the spec mandates.
      const field = Buffer.alloc(24)
      field.writeBigUInt64LE(BigInt(entry.data.length), 0)
      field.writeBigUInt64LE(BigInt(comp.length), 8)
      field.writeBigUInt64LE(BigInt(offset), 16)
      extra = Buffer.alloc(4 + field.length)
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(field.length, 2)
      field.copy(extra, 4)

      central.writeUInt32LE(U32_MAX, 20)
      central.writeUInt32LE(U32_MAX, 24)
      central.writeUInt32LE(U32_MAX, 42)
    } else {
      central.writeUInt32LE(comp.length, 20)
      central.writeUInt32LE(entry.data.length, 24)
      central.writeUInt32LE(offset, 42)
    }
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    centrals.push(central, name, extra)

    offset += local.length + name.length + comp.length
  }

  const localBlock = Buffer.concat(locals)
  const centralBlock = Buffer.concat(centrals)
  const cdOffset = localBlock.length
  const parts: Buffer[] = [localBlock, centralBlock]

  let eocdCount = entries.length
  let eocdOffset = cdOffset
  if (opts.zip64Eocd) {
    eocdCount = 0xffff
    eocdOffset = U32_MAX

    const eocd64 = Buffer.alloc(56)
    eocd64.writeUInt32LE(0x06064b50, 0)
    eocd64.writeBigUInt64LE(BigInt(44), 4) // size of remaining record
    eocd64.writeBigUInt64LE(BigInt(entries.length), 24) // entries on this disk
    eocd64.writeBigUInt64LE(BigInt(entries.length), 32) // total entries
    eocd64.writeBigUInt64LE(BigInt(centralBlock.length), 40)
    eocd64.writeBigUInt64LE(BigInt(cdOffset), 48)

    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(localBlock.length + centralBlock.length), 8)
    locator.writeUInt32LE(1, 16)

    parts.push(eocd64, locator)
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(eocdCount, 8)
  eocd.writeUInt16LE(eocdCount, 10)
  eocd.writeUInt32LE(centralBlock.length, 12)
  eocd.writeUInt32LE(eocdOffset, 16)
  parts.push(eocd)

  return Buffer.concat(parts)
}

describe('readZipEntries', () => {
  it('reads a classic (non-ZIP64) package', () => {
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'b.json', data: Buffer.from('{"x":1}') }
    ])

    expect(readZipEntries(zip).map((e) => [e.name, e.data.toString()])).toEqual([
      ['a.txt', 'hello'],
      ['b.json', '{"x":1}']
    ])
  })

  it('reads a ZIP64 package whose EOCD fields are saturated', () => {
    const zip = buildZip(
      [
        { name: 'big/one.txt', data: Buffer.from('first'), zip64: true },
        { name: 'big/two.txt', data: Buffer.from('second'), zip64: true }
      ],
      { zip64Eocd: true }
    )

    expect(readZipEntries(zip).map((e) => [e.name, e.data.toString()])).toEqual([
      ['big/one.txt', 'first'],
      ['big/two.txt', 'second']
    ])
  })

  it('reads ZIP64 per-entry offsets even with a classic EOCD', () => {
    const zip = buildZip([{ name: 'mixed.txt', data: Buffer.from('payload'), zip64: true }])

    expect(readZipEntries(zip)).toEqual([{ name: 'mixed.txt', data: Buffer.from('payload') }])
  })

  it('reports rather than swallows a package with no central directory', () => {
    const warnings: string[] = []

    expect(readZipEntries(Buffer.from('not a zip at all'), (line) => warnings.push(line))).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/EOCD/)
  })

  it('reports a corrupt entry instead of yielding an empty buffer for it', () => {
    const zip = buildZip([
      { name: 'good.txt', data: Buffer.from('fine') },
      { name: 'bad.txt', data: Buffer.from('doomed') }
    ])
    // Corrupt the second entry's deflate stream in place.
    const at = zip.indexOf(Buffer.from('bad.txt')) + 'bad.txt'.length
    zip.fill(0xff, at, at + 6)

    const warnings: string[] = []
    const entries = readZipEntries(zip, (line) => warnings.push(line))

    expect(entries.map((e) => e.name)).toEqual(['good.txt'])
    expect(warnings.join(' ')).toMatch(/bad\.txt/)
  })
})
