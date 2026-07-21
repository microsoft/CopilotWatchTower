import { describe, expect, it } from 'vitest'
import {
  normalizeUsageRow,
  parseCsvDicts,
  periodFromReport
} from '../src/main/usageMapping'

describe('usage report mapping', () => {
  it('parses BOM, quoted commas, escaped quotes, and CRLF rows', () => {
    const rows = parseCsvDicts(
      '\ufeffDisplay Name,User Principal Name,Report Period\r\n"Choi, Jeongwoo","choi""admin@example.com",30\r\n'
    )

    expect(rows).toEqual([
      {
        'Display Name': 'Choi, Jeongwoo',
        'User Principal Name': 'choi"admin@example.com',
        'Report Period': '30'
      }
    ])
  })

  it('maps report aliases and trims values', () => {
    const row = normalizeUsageRow({
      ' Display   Name ': '  Choi Jeongwoo ',
      'Microsoft Teams Copilot Last Activity Date': '2026-07-13',
      'Copilot Chat Last Activity Date': '2026-07-14',
      Unknown: 'ignored'
    })

    expect(row.display_name).toBe('Choi Jeongwoo')
    expect(row.last_activity_teams).toBe('2026-07-13')
    expect(row.last_activity_bizchat).toBe('2026-07-14')
    expect(row).not.toHaveProperty('Unknown')
  })

  it('normalizes numeric and prefixed report periods', () => {
    expect(periodFromReport('30', 'D7')).toBe('D30')
    expect(periodFromReport('d180', 'D7')).toBe('D180')
    expect(periodFromReport(null, 'D90')).toBe('D90')
  })
})