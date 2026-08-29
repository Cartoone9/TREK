import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import MPdfLightbox, { isAttachmentViewable } from './MPdfLightbox'
import { getFileBlob, openFile } from '../../../../utils/fileDownload'
import type { TripFile } from '../../../../types'

const getDocument = vi.fn()

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => getDocument(...args),
}))

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/mock-worker.mjs' }))

vi.mock('../../../../utils/fileDownload', () => ({
  getFileBlob: vi.fn(),
  openFile: vi.fn().mockResolvedValue(undefined),
  downloadFile: vi.fn().mockResolvedValue(undefined),
}))

const t = (key: string) => key

const file = { id: 1, url: '/uploads/qr.pdf', original_name: 'qr.pdf', mime_type: 'application/pdf' } as unknown as TripFile

function mockDoc(numPages: number) {
  return {
    numPages,
    getPage: vi.fn().mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
      render: () => ({ promise: Promise.resolve() }),
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
}

// The whole point of this viewer: a PDF renders inside the app,
// through the offline-capable blob path, with the old navigate-away behaviour
// demoted to an explicit escape hatch — because in the iOS standalone PWA that
// navigation re-boots the SPA on return.
describe('MPdfLightbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getFileBlob).mockResolvedValue(new Blob(['%PDF-1.4'], { type: 'application/pdf' }))
    getDocument.mockReturnValue({ promise: Promise.resolve(mockDoc(3)) })
  })

  it('MPDF-001: renders one canvas per page — all three pages of a multi-page document, not just the first', async () => {
    const { container } = render(<MPdfLightbox file={file} onClose={() => {}} t={t} />)
    await waitFor(() => expect(container.ownerDocument.querySelectorAll('canvas')).toHaveLength(3))
  })

  it('MPDF-002: the document comes through getFileBlob — the same server-then-offline-cache path as every attachment', async () => {
    render(<MPdfLightbox file={file} onClose={() => {}} t={t} />)
    await waitFor(() => expect(getFileBlob).toHaveBeenCalledWith('/uploads/qr.pdf'))
  })

  it('MPDF-003: closing calls onClose and never openFile — no navigation happened anywhere on the default path', async () => {
    const onClose = vi.fn()
    const { container } = render(<MPdfLightbox file={file} onClose={onClose} t={t} />)
    await waitFor(() => expect(container.ownerDocument.querySelectorAll('canvas')).toHaveLength(3))
    fireEvent.click(screen.getByLabelText('common.close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(openFile).not.toHaveBeenCalled()
  })

  it('MPDF-004: a document that fails to load shows the error state whose fallback is the old openFile path', async () => {
    getDocument.mockReturnValue({ promise: Promise.reject(new Error('bad pdf')) })
    render(<MPdfLightbox file={file} onClose={() => {}} t={t} />)
    const fallback = await screen.findByText('files.openTab')
    fireEvent.click(fallback)
    expect(openFile).toHaveBeenCalledWith('/uploads/qr.pdf', 'qr.pdf')
  })

  it('MPDF-005: the header keeps an explicit open-externally escape hatch for when the in-app render is not enough', async () => {
    const { container } = render(<MPdfLightbox file={file} onClose={() => {}} t={t} />)
    await waitFor(() => expect(container.ownerDocument.querySelectorAll('canvas')).toHaveLength(3))
    fireEvent.click(screen.getByLabelText('files.openTab'))
    expect(openFile).toHaveBeenCalledWith('/uploads/qr.pdf', 'qr.pdf')
  })

  it('MPDF-006: a raster image renders as an <img> from the same blob path — and never loads pdf.js', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:img')
    URL.revokeObjectURL = vi.fn()
    vi.mocked(getFileBlob).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    const imgFile = { ...file, url: '/uploads/qr.png', original_name: 'qr.png', mime_type: 'image/png' } as unknown as TripFile
    render(<MPdfLightbox file={imgFile} onClose={() => {}} t={t} />)
    const img = await screen.findByAltText('qr.png')
    expect(img).toHaveProperty('src', expect.stringContaining('blob:img'))
    expect(getDocument).not.toHaveBeenCalled()
  })

  it('MPDF-008: a long document renders only its first pages up front — the rest render when they scroll near, and a rendered page is unobserved', async () => {
    // jsdom has no IntersectionObserver (the component then falls back to
    // eager rendering, which is what every other test exercises); a controllable
    // stand-in makes the lazy path testable.
    const instances: { cb: IntersectionObserverCallback; observed: Element[]; unobserved: Element[] }[] = []
    class MockIO {
      observed: Element[] = []
      unobserved: Element[] = []
      constructor(public cb: IntersectionObserverCallback) { instances.push(this as never) }
      observe(el: Element) { this.observed.push(el) }
      unobserve(el: Element) { this.unobserved.push(el) }
      disconnect() {}
    }
    ;(globalThis as any).IntersectionObserver = MockIO
    try {
      getDocument.mockReturnValue({ promise: Promise.resolve(mockDoc(40)) })
      const { container } = render(<MPdfLightbox file={file} onClose={() => {}} t={t} />)
      const docEl = container.ownerDocument
      // 40 placeholders, but only the eager pages hold a canvas.
      await waitFor(() => expect(docEl.querySelectorAll('[data-page]')).toHaveLength(40))
      await waitFor(() => expect(docEl.querySelectorAll('canvas')).toHaveLength(4))
      expect(instances).toHaveLength(1)
      expect(instances[0].observed).toHaveLength(36)
      // Page 10 scrolls near: it renders, and only then leaves the observer.
      const slot10 = docEl.querySelector('[data-page="10"]') as Element
      instances[0].cb([{ isIntersecting: true, target: slot10 } as never], instances[0] as never)
      await waitFor(() => expect(slot10.querySelector('canvas')).not.toBeNull())
      await waitFor(() => expect(instances[0].unobserved).toContain(slot10))
      expect(docEl.querySelectorAll('canvas')).toHaveLength(5)
    } finally {
      delete (globalThis as any).IntersectionObserver
    }
  })

  it('MPDF-009: closing the viewer destroys the pdf.js document — its worker memory does not outlive the overlay', async () => {
    const doc = mockDoc(3)
    getDocument.mockReturnValue({ promise: Promise.resolve(doc) })
    const { container, unmount } = render(<MPdfLightbox file={file} onClose={() => {}} t={t} />)
    await waitFor(() => expect(container.ownerDocument.querySelectorAll('canvas')).toHaveLength(3))
    unmount()
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })

  it('MPDF-007: isAttachmentViewable admits PDFs and raster images, and refuses what must stay browser-native', () => {
    expect(isAttachmentViewable('application/pdf')).toBe(true)
    expect(isAttachmentViewable('image/png')).toBe(true)
    expect(isAttachmentViewable('image/jpeg')).toBe(true)
    // SVG can script; .pkpass must reach Apple Wallet (#1447); absent mime = old path.
    expect(isAttachmentViewable('image/svg+xml')).toBe(false)
    expect(isAttachmentViewable('application/vnd.apple.pkpass')).toBe(false)
    expect(isAttachmentViewable(undefined)).toBe(false)
  })
})
