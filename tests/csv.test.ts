import { describe, expect, it } from 'vitest'
import { toCsv } from '../src/main/csv'

describe('toCsv', () => {
  it('returns an empty string for no rows', () => {
    expect(toCsv([])).toBe('')
  })

  it('writes a header row and CRLF line endings', () => {
    expect(toCsv([{ id: 'a', n: 1 }, { id: 'b', n: 2 }])).toBe('id,n\r\na,1\r\nb,2')
  })

  it('quotes and escapes values that would otherwise break the row structure', () => {
    const csv = toCsv([{ text: 'has "quotes", a comma\nand a newline' }])

    expect(csv).toBe('text\r\n"has ""quotes"", a comma\nand a newline"')
  })

  it('renders null and undefined as empty cells rather than the literal words', () => {
    expect(toCsv([{ a: null, b: undefined, c: 0, d: false }])).toBe('a,b,c,d\r\n,,0,false')
  })

  it('keeps the column set stable across rows with differing keys', () => {
    // The first row defines the schema; a later row's extra key must not shift
    // the columns of an already-written export.
    expect(toCsv([{ a: 1 }, { a: 2, b: 3 } as Record<string, unknown>])).toBe('a\r\n1\r\n2')
  })
})
