import {
  annualizeCompensationAmount,
  type CompensationPreference,
} from '@nestor/contracts'

const knownCompensationPeriods = new Set([
  'yr',
  'year',
  'years',
  'annual',
  'annum',
  'mo',
  'month',
  'months',
  'wk',
  'week',
  'weeks',
  'day',
  'days',
  'hr',
  'hrs',
  'hour',
  'hours',
])

const compensationPeriodAliases: Record<string, string> = {
  hourly: 'hour',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
  annually: 'annual',
}

const annualCompensationMultipliers: Record<string, number> = {
  yr: 1,
  year: 1,
  years: 1,
  annual: 1,
  annum: 1,
  mo: 12,
  month: 12,
  months: 12,
  wk: 52,
  week: 52,
  weeks: 52,
  day: 260,
  days: 260,
  hr: 2080,
  hrs: 2080,
  hour: 2080,
  hours: 2080,
}

const salaryNumberPattern = /(\d[\d,]*(?:\.\d+)?)(?:\s*([km])\b)?/gi
const secondaryCompensationBeforePattern = /\b(bonus|commission|sign[- ]?on|equity|ote)\b/i
const secondaryCompensationAfterPattern = /^(?:[:-]\s*)?(bonus|commission|sign[- ]?on|equity|ote)\b/i

interface ParsedSalaryNumber {
  absoluteValue: number
  index: number
  length: number
}

export function normalizeText(value: string): string {
  return value
    .replace(/(^|[^\p{L}\p{N}])c\s*\+\s*\+(?=$|[^\p{L}\p{N}])/giu, '$1cplusplus')
    .replace(/(^|[^\p{L}\p{N}])c\s*#(?=$|[^\p{L}\p{N}])/giu, '$1csharp')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function tokenize(value: string): string[] {
  return normalizeText(value).split(/\s+/).filter(Boolean)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readPeriodUnit(salaryText: string, startIndex: number): string | null {
  const followingText = salaryText.slice(startIndex).trimStart().toLowerCase()

  const rawPeriodUnit =
    followingText.match(/^(?:(?:\/|per\b|a\b)\s*)?([a-z]+)/)?.[1] ?? ''
  const periodUnit = compensationPeriodAliases[rawPeriodUnit] ?? rawPeriodUnit
  return knownCompensationPeriods.has(periodUnit) ? periodUnit : null
}

function isCompactRangeSeparator(text: string): boolean {
  return /^\s*[-–—/]\s*$/.test(text)
}

function parseSalaryNumbers(salaryText: string): ParsedSalaryNumber[] {
  const matches = [...salaryText.matchAll(salaryNumberPattern)]

  if (matches.length === 0) {
    return []
  }

  return matches
    .map((match, index) => {
      const baseValue = parseFloat((match[1] ?? '').replaceAll(',', ''))
      const rawSuffix = (match[2] ?? '').toLowerCase()
      const currentIndex = match.index ?? 0
      const nextMatch = matches[index + 1]
      const nextIndex = nextMatch?.index ?? -1
      const betweenText = nextMatch
        ? salaryText.slice(currentIndex + match[0].length, nextIndex)
        : ''
      const inheritedSuffix =
        !rawSuffix && nextMatch?.[2] && isCompactRangeSeparator(betweenText)
          ? nextMatch[2].toLowerCase()
          : rawSuffix
      const periodUnit =
        readPeriodUnit(salaryText, currentIndex + match[0].length) ??
        (nextMatch && isCompactRangeSeparator(betweenText)
          ? readPeriodUnit(salaryText, (nextMatch.index ?? 0) + nextMatch[0].length)
          : null)
      const precedingText = salaryText.slice(Math.max(0, currentIndex - 24), currentIndex).toLowerCase()
      const followingText = salaryText.slice(currentIndex + match[0].length).trimStart().toLowerCase()

      if (!Number.isFinite(baseValue) || baseValue <= 0) {
        return null
      }

      if (followingText.startsWith('%')) {
        return null
      }

      const trailingContext = followingText.slice(0, 24)
      const leadingContext = precedingText.trim().split(/\s+/).at(-1) ?? ''

      if (
        secondaryCompensationBeforePattern.test(leadingContext) ||
        secondaryCompensationAfterPattern.test(trailingContext)
      ) {
        return null
      }

      if (!inheritedSuffix && !periodUnit && baseValue < 1000) {
        return null
      }

      const scaledValue =
        inheritedSuffix === 'k'
          ? baseValue * 1000
          : inheritedSuffix === 'm'
            ? baseValue * 1_000_000
            : baseValue
      const annualizedValue = periodUnit
        ? scaledValue * (annualCompensationMultipliers[periodUnit] ?? 1)
        : scaledValue

      return {
        absoluteValue: annualizedValue,
        index: currentIndex,
        length: match[0].length,
      }
    })
    .filter((value): value is ParsedSalaryNumber => value !== null)
}

export function matchesAnyPhrase(candidate: string, desiredValues: readonly string[]): boolean {
  if (desiredValues.length === 0) {
    return true
  }

  const normalizedCandidate = normalizeText(candidate)
  const candidateTokens = new Set(tokenize(candidate))

  return desiredValues.some((desiredValue) => {
    const normalizedDesired = normalizeText(desiredValue)
    if (!normalizedDesired) {
      return false
    }

    const desiredTokens = tokenize(desiredValue)
    if (desiredTokens.length === 0) {
      return false
    }

    if (desiredTokens.length === 1 && candidateTokens.has(normalizedDesired)) {
      return true
    }

    if (new RegExp(`(^|\\s)${escapeRegex(normalizedDesired)}($|\\s)`).test(normalizedCandidate)) {
      return true
    }

    return desiredTokens.every((token) => candidateTokens.has(token))
  })
}

export function parseSalaryFloor(salaryText: string | null): number | null {
  if (!salaryText) {
    return null
  }

  const parsedNumbers = parseSalaryNumbers(salaryText).map((entry) => entry.absoluteValue)

  if (parsedNumbers.length === 0) {
    return null
  }

  return Math.min(...parsedNumbers)
}

function detectCurrencyCode(salaryText: string | null): string | null {
  if (!salaryText) {
    return null
  }

  const normalized = salaryText.toLowerCase()
  if (normalized.includes('usd') || salaryText.includes('$')) return 'USD'
  if (normalized.includes('eur') || salaryText.includes('€')) return 'EUR'
  if (normalized.includes('gbp') || salaryText.includes('£')) return 'GBP'
  return null
}

export function meetsCompensationMinimum(
  salaryText: string | null,
  preference: CompensationPreference,
): boolean {
  if (
    preference.minimum === null ||
    preference.currencyStatus === 'needs_clarification' ||
    preference.currency === null
  ) {
    return true
  }

  const listingFloor = parseSalaryFloor(salaryText)
  const listingCurrency = detectCurrencyCode(salaryText)
  if (
    listingFloor === null ||
    listingCurrency === null ||
    listingCurrency !== preference.currency.toUpperCase()
  ) {
    return true
  }

  return listingFloor >= annualizeCompensationAmount(preference.minimum, preference.interval)
}
