import { describe, expect, test } from 'vitest'
import { meetsCompensationMinimum, parseSalaryFloor } from './shared'

describe('catalog session compensation helpers', () => {
  test('annualizes common monthly salary wording', () => {
    expect(parseSalaryFloor('Compensation: €2,500 per month')).toBe(30_000)
    expect(parseSalaryFloor('Compensation: €2,500 monthly')).toBe(30_000)
  })

  test('filters only explicit same-currency salary evidence', () => {
    const preference = {
      minimum: 2_000,
      maximum: 4_000,
      interval: 'month' as const,
      currency: 'EUR',
      currencyStatus: 'explicit' as const,
    }

    expect(meetsCompensationMinimum('EUR 30k/year', preference)).toBe(true)
    expect(meetsCompensationMinimum('EUR 18k/year', preference)).toBe(false)
    expect(meetsCompensationMinimum('€2,500 monthly', preference)).toBe(true)
    expect(meetsCompensationMinimum('USD $100k/year', preference)).toBe(true)
    expect(meetsCompensationMinimum('Competitive', preference)).toBe(true)
  })
})
