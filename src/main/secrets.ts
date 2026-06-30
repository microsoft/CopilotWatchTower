/**
 * Windows DPAPI via koffi (prebuilt FFI — no compiler, portable). Reads/writes
 * secrets in the SAME format the Python app uses (entropy + "DP1\0" tag) so the
 * shared store.db stays interoperable.
 */
import koffi from 'koffi'

type FfiFn = (...args: unknown[]) => boolean
type FreeFn = (p: unknown) => unknown

let unprotectFn: FfiFn | null = null
let protectFn: FfiFn | null = null
let localFree: FreeFn | null = null

const ENTROPY = Buffer.from('CopilotWatchTower::v1::secret', 'utf8')
const TAG = Buffer.from([0x44, 0x50, 0x31, 0x00]) // "DP1\0"

function ensure(): void {
  if (unprotectFn) return
  const crypt32 = koffi.load('crypt32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  koffi.struct('DATA_BLOB', { cbData: 'uint32_t', pbData: 'uint8_t*' })
  unprotectFn = crypt32.func(
    'bool CryptUnprotectData(DATA_BLOB *pDataIn, void *ppszDataDescr, DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ DATA_BLOB *pDataOut)'
  ) as unknown as FfiFn
  protectFn = crypt32.func(
    'bool CryptProtectData(DATA_BLOB *pDataIn, str16 szDataDescr, DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ DATA_BLOB *pDataOut)'
  ) as unknown as FfiFn
  localFree = kernel32.func('void *LocalFree(void *hMem)') as unknown as FreeFn
}

export function dpapiUnprotect(blob: Buffer): string {
  ensure()
  const cipher = blob.length >= 4 && blob.subarray(0, 4).equals(TAG) ? blob.subarray(4) : blob
  const o: { cbData: number; pbData: unknown } = { cbData: 0, pbData: null }
  const ok = unprotectFn!(
    { cbData: cipher.length, pbData: cipher },
    null,
    { cbData: ENTROPY.length, pbData: ENTROPY },
    null,
    null,
    0x1,
    o
  )
  if (!ok) throw new Error('CryptUnprotectData failed')
  const bytes = koffi.decode(o.pbData, koffi.array('uint8_t', o.cbData)) as number[]
  localFree!(o.pbData)
  return Buffer.from(bytes).toString('utf8')
}

export function dpapiProtect(text: string): Buffer {
  ensure()
  const payload = Buffer.from(text, 'utf8')
  const o: { cbData: number; pbData: unknown } = { cbData: 0, pbData: null }
  const ok = protectFn!(
    { cbData: payload.length, pbData: payload },
    'CopilotWatchTower',
    { cbData: ENTROPY.length, pbData: ENTROPY },
    null,
    null,
    0x1,
    o
  )
  if (!ok) throw new Error('CryptProtectData failed')
  const bytes = koffi.decode(o.pbData, koffi.array('uint8_t', o.cbData)) as number[]
  localFree!(o.pbData)
  return Buffer.concat([TAG, Buffer.from(bytes)])
}
