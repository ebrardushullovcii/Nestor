import { describe, expect, test } from 'vitest'
import {
  resolveAdvancedInterviewSurfacesEnabled,
  resolveVisibleInterviewPopupInputMode,
} from './interview-surface-mode'

describe('Live Assistant surface mode', () => {
  test('enables popup surfaces by default', () => {
    expect(resolveAdvancedInterviewSurfacesEnabled(undefined)).toBe(true)
    expect(resolveAdvancedInterviewSurfacesEnabled('')).toBe(true)
    expect(resolveAdvancedInterviewSurfacesEnabled('1')).toBe(true)
  })

  test('retains an explicit visible-chat-only escape hatch', () => {
    expect(resolveAdvancedInterviewSurfacesEnabled('0')).toBe(false)
  })

  test('keeps visible popup windows focusable and pointer-interactive', () => {
    expect(resolveVisibleInterviewPopupInputMode()).toEqual({
      focusable: true,
      ignoreMouseEvents: false,
    })
  })
})
