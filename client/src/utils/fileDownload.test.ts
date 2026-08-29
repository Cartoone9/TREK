import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openFile, getFileBlob } from './fileDownload'
import { getCachedBlob } from '../db/offlineDb'
import { isEffectivelyOffline } from '../sync/networkMode'

vi.mock('../db/offlineDb', () => ({
  getCachedBlob: vi.fn(),
}))

vi.mock('../sync/networkMode', () => ({
  isEffectivelyOffline: vi.fn(() => true),
}))

// getFileBlob is exported for the in-app PDF viewer
// (MPdfLightbox), which needs the same server-then-offline-cache resolution
// without any of the open/download behaviour. These tests pin the two facts the
// viewer depends on: the offline path serves the pre-downloaded blob, and
// openFile's iOS-standalone branch still behaves as shipped for everything the
// viewer does not intercept.
describe('fileDownload', () => {
  const pdfBlob = new Blob(['%PDF-1.4'], { type: 'application/pdf' })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCachedBlob).mockResolvedValue(pdfBlob)
    vi.mocked(isEffectivelyOffline).mockReturnValue(true)
    URL.createObjectURL = vi.fn(() => 'blob:test')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    delete (navigator as any).standalone
    vi.restoreAllMocks()
  })

  it('FILEDL-001: getFileBlob serves the offline cache when effectively offline', async () => {
    const blob = await getFileBlob('/uploads/qr.pdf')
    expect(getCachedBlob).toHaveBeenCalledWith('/uploads/qr.pdf')
    expect(blob).toBe(pdfBlob)
  })

  it('FILEDL-002: getFileBlob refuses a non-relative URL before touching anything', async () => {
    await expect(getFileBlob('https://evil.example/x.pdf')).rejects.toThrow(/non-relative/)
    expect(getCachedBlob).not.toHaveBeenCalled()
  })

  it('FILEDL-003: openFile in iOS standalone mode still uses the anchor path (shipped behaviour, untouched)', async () => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await openFile('/uploads/qr.pdf', 'qr.pdf')
    expect(clicks).toHaveBeenCalledTimes(1)
  })
})
