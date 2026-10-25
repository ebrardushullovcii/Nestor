import { describe, expect, test } from 'vitest'
import {
  matchesAnyPhrase,
  meetsCompensationMinimum,
  normalizeText,
  parseSalaryFloor,
} from './catalog-runtime-utils'

describe('catalog runtime utils', () => {
  test('normalizes diacritics consistently', () => {
    expect(normalizeText('São Paulo')).toBe('sao paulo')
    expect(normalizeText('Sao Paulo')).toBe('sao paulo')
    expect(normalizeText('C++')).toBe('cplusplus')
    expect(normalizeText('C#')).toBe('csharp')
  })

  test('ignores implausible small non-salary numbers when parsing salary floors', () => {
    expect(parseSalaryFloor('100% employer match and salary range 120k - 140k')).toBe(120000)
    expect(parseSalaryFloor('Compensation: 95k/yr plus bonus')).toBe(95000)
    expect(parseSalaryFloor('Base salary 120000/year')).toBe(120000)
    expect(parseSalaryFloor('Base salary 120k + 20k bonus')).toBe(120000)
    expect(parseSalaryFloor('Comp plan has a 50/50 split and 120k base')).toBe(120000)
    expect(parseSalaryFloor('Remote 24/7 support with compensation of 95000 USD')).toBe(95000)
    expect(parseSalaryFloor('Compensation: 1.2M total target cash')).toBe(1200000)
    expect(parseSalaryFloor('Compensation: 80-100k')).toBe(80000)
    expect(parseSalaryFloor('Compensation: 1-1.2M total target cash')).toBe(1000000)
    expect(parseSalaryFloor('Compensation: 60/hr')).toBe(124800)
    expect(parseSalaryFloor('Compensation: €2,500 per month')).toBe(30000)
    expect(parseSalaryFloor('Compensation: €2,500 monthly')).toBe(30000)
    expect(parseSalaryFloor('Compensation: 5-7k/mo')).toBe(60000)
    expect(parseSalaryFloor('Compensation: 50k-60k/mo')).toBe(600000)
    expect(parseSalaryFloor('Remote role compensation is 95k/year')).toBe(95000)
    expect(parseSalaryFloor('20k bonus + 120k base')).toBe(120000)
    expect(parseSalaryFloor('OTE 180k, base 150k')).toBe(150000)
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

  test('matches whole tokens instead of raw substrings', () => {
    expect(matchesAnyPhrase('Senior Java Engineer', ['java'])).toBe(true)
    expect(matchesAnyPhrase('Senior JavaScript Engineer', ['java'])).toBe(false)
    expect(matchesAnyPhrase('New York City', ['new york'])).toBe(true)
    expect(matchesAnyPhrase('Senior C++ Engineer', ['C++'])).toBe(true)
    expect(matchesAnyPhrase('Senior C# Engineer', ['C#'])).toBe(true)
    expect(matchesAnyPhrase('Senior C Engineer', ['C++'])).toBe(false)
    expect(matchesAnyPhrase('Senior C Engineer', ['C#'])).toBe(false)
  })
})
