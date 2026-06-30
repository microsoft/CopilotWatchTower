/**
 * Copilot usage report column mapping + a minimal RFC-4180 CSV parser.
 * Port of usage_mapping.py (+ csv.DictReader behaviour).
 */

export const USAGE_FIELDS = [
  'display_name',
  'upn',
  'last_activity_overall',
  'last_activity_teams',
  'last_activity_word',
  'last_activity_excel',
  'last_activity_powerpoint',
  'last_activity_outlook',
  'last_activity_onenote',
  'last_activity_loop',
  'last_activity_bizchat',
  'report_refresh_date',
  'report_period'
] as const

const COLUMN_MAP: Record<string, string> = {
  'display name': 'display_name',
  'user principal name': 'upn',
  'last activity date': 'last_activity_overall',
  'last activity of microsoft teams copilot': 'last_activity_teams',
  'microsoft teams copilot last activity date': 'last_activity_teams',
  'last activity of word copilot': 'last_activity_word',
  'word copilot last activity date': 'last_activity_word',
  'last activity of excel copilot': 'last_activity_excel',
  'excel copilot last activity date': 'last_activity_excel',
  'last activity of powerpoint copilot': 'last_activity_powerpoint',
  'powerpoint copilot last activity date': 'last_activity_powerpoint',
  'last activity of outlook copilot': 'last_activity_outlook',
  'outlook copilot last activity date': 'last_activity_outlook',
  'last activity of onenote copilot': 'last_activity_onenote',
  'onenote copilot last activity date': 'last_activity_onenote',
  'last activity of loop copilot': 'last_activity_loop',
  'loop copilot last activity date': 'last_activity_loop',
  'last activity of copilot chat': 'last_activity_bizchat',
  'copilot chat last activity date': 'last_activity_bizchat',
  'report refresh date': 'report_refresh_date',
  'report period': 'report_period'
}

export function normaliseColumn(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).join(' ')
}

export function clean(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}

export function normalizeUsageRow(raw: Record<string, string>): Record<string, string | null> {
  const projected: Record<string, string | null> = {}
  for (const f of USAGE_FIELDS) projected[f] = null
  for (const [column, value] of Object.entries(raw)) {
    const target = COLUMN_MAP[normaliseColumn(column)]
    if (target) projected[target] = clean(value)
  }
  return projected
}

export function periodFromReport(rawPeriod: string | null, fallback: string): string {
  if (rawPeriod) {
    const value = rawPeriod.trim()
    if (/^\d+$/.test(value)) return `D${value}`
    if (value.toUpperCase().startsWith('D')) return value.toUpperCase()
  }
  return fallback
}

/**
 * Parse CSV text into an array of header→value records (csv.DictReader).
 * Handles quoted fields, escaped quotes (""), and CRLF/LF newlines.
 */
export function parseCsvDicts(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else if (c === '\r') {
      // ignore; handled by the following \n
    } else {
      field += c
    }
  }
  // Flush trailing field/row (no final newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) return []
  const header = rows[0]
  const out: Record<string, string>[] = []
  for (let r = 1; r < rows.length; r++) {
    const values = rows[r]
    if (values.length === 1 && values[0] === '') continue // skip blank lines
    const rec: Record<string, string> = {}
    for (let c = 0; c < header.length; c++) rec[header[c]] = values[c] ?? ''
    out.push(rec)
  }
  return out
}
