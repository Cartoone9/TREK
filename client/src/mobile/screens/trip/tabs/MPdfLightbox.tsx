import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, ExternalLink, X } from 'lucide-react'
import { getFileBlob, downloadFile, openFile } from '../../../../utils/fileDownload'
import { lockBodyScroll } from '../../../../utils/bodyScrollLock'
import type { TranslationFn, TripFile } from '../../../../types'

function sheetRoot(): HTMLElement {
  return document.getElementById('m-sheet-root') ?? document.body
}

interface MPdfLightboxProps {
  file: TripFile
  onClose: () => void
  t: TranslationFn
}

// Raster images share this viewer so every attachment opens through one UI —
// they render as a plain <img> from the same offline-capable blob and never
// load pdf.js. (SVG stays out on purpose: it can script, and openFile already
// forces it to download.)
const VIEWABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** True when the attachment should open in MPdfLightbox instead of openFile(). */
export function isAttachmentViewable(mime: string | undefined): boolean {
  return mime === 'application/pdf' || (!!mime && VIEWABLE_IMAGE_TYPES.has(mime))
}

/**
 * In-app viewer for the mobile trip tabs — PDFs and raster images.
 *
 * In the iOS add-to-home-screen PWA a PDF cannot open in a new tab (Safari
 * cannot read the WebView's blob URLs), so openFile() falls back to navigating
 * the WebView itself to the file — and returning from that viewer evicts and
 * re-boots the whole SPA. Embedding is no way out either: WebKit renders an
 * embedded PDF first-page-only. So the pages are rendered here with pdf.js,
 * each onto its own canvas in a scrollable overlay: opening a reservation's
 * PDF costs the app nothing, online or in airplane mode (the blob resolves
 * through the same server-then-offline-cache path as every attachment).
 * pdf.js and its worker are imported lazily on first use — precached for
 * offline, but never paid for by sessions that open no PDF.
 */
export default function MPdfLightbox({ file, onClose, t }: MPdfLightboxProps) {
  const pagesRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [imgUrl, setImgUrl] = useState('')

  useEffect(() => lockBodyScroll(), [])

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    let doc: { destroy: () => Promise<void> } | null = null
    let observer: IntersectionObserver | null = null
    ;(async () => {
      try {
        if (VIEWABLE_IMAGE_TYPES.has(file.mime_type)) {
          const blob = await getFileBlob(file.url)
          if (cancelled) return
          objectUrl = URL.createObjectURL(blob)
          setImgUrl(objectUrl)
          setState('ready')
          return
        }
        const [pdfjs, worker, blob] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
          getFileBlob(file.url),
        ])
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        const loaded = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise
        doc = loaded
        const host = pagesRef.current
        if (cancelled || !host) return
        setState('ready')
        // The page slots are appended manually and never touched by React — the
        // loading/error nodes live in their own sibling, so the two cannot
        // fight over children.
        host.textContent = ''
        // Backing resolution capped at 3× CSS pixels: crisp enough that a
        // boarding-pass QR scans straight off the screen, without an A4 page
        // eating more than it must.
        const cssWidth = host.clientWidth
        const dpr = Math.min(window.devicePixelRatio || 1, 3)
        // The first page's aspect ratio sizes every placeholder, so the scroll
        // range is honest from the start; a mixed-orientation page corrects
        // itself the moment it renders.
        const first = await loaded.getPage(1)
        if (cancelled) return
        const v1 = first.getViewport({ scale: 1 })

        const inFlight = new Set<number>()
        const renderPage = async (n: number, slot: HTMLElement) => {
          if (cancelled || inFlight.has(n) || slot.dataset.rendered) return
          inFlight.add(n)
          try {
            const page = n === 1 ? first : await loaded.getPage(n)
            if (cancelled) return
            const base = page.getViewport({ scale: 1 })
            const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr })
            const canvas = document.createElement('canvas')
            canvas.width = viewport.width
            canvas.height = viewport.height
            canvas.style.cssText = 'display:block;width:100%;'
            await page.render({ canvas, viewport }).promise
            if (cancelled) return
            slot.style.aspectRatio = ''
            slot.textContent = ''
            slot.appendChild(canvas)
            slot.dataset.rendered = '1'
          } finally {
            inFlight.delete(n)
          }
        }

        // Memory is the constraint, not CPU: a rendered page holds ~8 MB of
        // canvas at the 3× cap, so a long document must not render up front.
        // The first pages render eagerly — the whole file, for the typical
        // short travel PDF — and the rest render as they approach the
        // viewport. Rendered pages are kept: scrolling far pays for what was
        // actually read, never for the whole document.
        const EAGER_PAGES = 4
        const slots: HTMLElement[] = []
        for (let n = 1; n <= loaded.numPages; n++) {
          const slot = document.createElement('div')
          slot.style.cssText = 'width:100%;background:white;border-radius:8px;margin-bottom:12px;overflow:hidden;'
          slot.style.aspectRatio = String(v1.width / v1.height)
          slot.dataset.page = String(n)
          host.appendChild(slot)
          slots.push(slot)
        }
        for (let n = 1; n <= Math.min(EAGER_PAGES, loaded.numPages); n++) {
          await renderPage(n, slots[n - 1])
          if (cancelled) return
        }
        if (loaded.numPages > EAGER_PAGES) {
          if (typeof IntersectionObserver === 'function') {
            observer = new IntersectionObserver(entries => {
              for (const e of entries) {
                if (!e.isIntersecting) continue
                const slot = e.target as HTMLElement
                // Unobserve only after a successful render — a page that failed
                // (a corrupt object, a transient hiccup) gets retried the next
                // time it scrolls into view instead of staying blank forever.
                void renderPage(Number(slot.dataset.page), slot)
                  .then(() => { if (slot.dataset.rendered) observer?.unobserve(slot) })
                  .catch(() => {})
              }
            }, { root: host.parentElement, rootMargin: '150% 0%' })
            for (const slot of slots.slice(EAGER_PAGES)) observer.observe(slot)
          } else {
            // No IntersectionObserver (older WebKit, test environment): render
            // everything eagerly, as before the lazy path existed.
            for (let n = EAGER_PAGES + 1; n <= loaded.numPages; n++) {
              await renderPage(n, slots[n - 1])
              if (cancelled) return
            }
          }
        }
      } catch {
        if (!cancelled) setState('error')
      }
    })()
    return () => {
      cancelled = true
      observer?.disconnect()
      if (doc) void doc.destroy()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file.url, file.mime_type])

  const headerBtn: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.85)',
    display: 'flex', padding: 8, borderRadius: 8, flexShrink: 0,
  }

  return createPortal(
    <div
      role="dialog"
      aria-label={file.original_name}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.92)', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 8px 6px 16px', paddingTop: 'calc(10px + env(safe-area-inset-top))', flexShrink: 0 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'white', fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600 }}>
          {file.original_name}
        </span>
        <button type="button" aria-label={t('files.download')} style={headerBtn}
          onClick={() => { void downloadFile(file.url, file.original_name) }}>
          <Download size={18} />
        </button>
        <button type="button" aria-label={t('files.openTab')} style={headerBtn}
          onClick={() => { void openFile(file.url, file.original_name) }}>
          <ExternalLink size={18} />
        </button>
        <button type="button" aria-label={t('common.close')} style={headerBtn} onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '4px 12px calc(16px + env(safe-area-inset-bottom))' }}>
        {imgUrl && (
          <img
            src={imgUrl}
            alt={file.original_name}
            style={{ display: 'block', width: '100%', background: 'white', borderRadius: 8 }}
          />
        )}
        <div ref={pagesRef} />
        {state === 'loading' && (
          <p style={{ color: 'rgba(255,255,255,0.7)', textAlign: 'center', marginTop: 48, fontSize: 13 }}>{t('common.loading')}</p>
        )}
        {state === 'error' && (
          <div style={{ color: 'rgba(255,255,255,0.85)', textAlign: 'center', marginTop: 48, fontSize: 13 }}>
            <p style={{ marginBottom: 12 }}>{t('files.openError')}</p>
            <button type="button"
              onClick={() => { void openFile(file.url, file.original_name) }}
              style={{ color: 'white', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}>
              {t('files.openTab')}
            </button>
          </div>
        )}
      </div>
    </div>,
    sheetRoot()
  )
}
