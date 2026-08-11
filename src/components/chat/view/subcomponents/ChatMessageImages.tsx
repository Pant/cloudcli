import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import type { ChatImage } from '../../types/types';

import { createChatImageBlobCache } from './chatImageBlobCache';

type ChatMessageImagesProps = { images: ChatImage[]; projectId?: string | null };
const blobCache = createChatImageBlobCache({
  fetchBlob: async (url, signal) => {
    const response = await authenticatedFetch(url, { signal });
    return response.ok ? response.blob() : null;
  },
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
});

function imageUrls(imagePath: string, projectId: string | null | undefined, thumbnail: boolean): string[] {
  const filename = imagePath.split(/[\\/]/).pop() || '';
  const original = `/api/assets/images/${encodeURIComponent(filename)}`;
  return [
    ...(thumbnail ? [`${original}/thumbnail`] : []),
    original,
    ...(projectId ? [`/api/file-tree/projects/${projectId}/files/content?path=${encodeURIComponent(imagePath)}`] : []),
  ];
}

function useVisible(elementRef: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (!('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '240px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef]);
  return visible;
}

function useChatImageSrc(image: ChatImage, projectId: string | null | undefined, enabled: boolean, thumbnail: boolean) {
  const imageData = image.data;
  const imagePath = image.path;
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({ src: imageData || null, failed: false });
  useEffect(() => {
    if (imageData) {
      setState({ src: imageData, failed: false });
      return;
    }
    if (!enabled || !imagePath) return;
    let active = true;
    setState({ src: null, failed: false });
    const urls = imageUrls(imagePath, projectId, thumbnail);
    const acquired = blobCache.acquire(`${thumbnail ? 'thumb' : 'original'}:${urls.join('|')}`, urls);
    void acquired.promise.then((src) => active && setState({ src, failed: false })).catch((error) => {
      if (active && !(error instanceof Error && error.name === 'AbortError')) setState({ src: null, failed: true });
    });
    return () => {
      active = false;
      acquired.release();
    };
  }, [enabled, imageData, imagePath, projectId, thumbnail]);
  return state;
}

export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label={alt}>
      <button type="button" onClick={onClose} aria-label="Close image preview" className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"><X className="h-5 w-5" /></button>
      <img src={src} alt={alt} decoding="async" onClick={(event) => event.stopPropagation()} className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" />
    </div>, document.body,
  );
}

function OriginalImageLightbox({ image, projectId, alt, onClose }: { image: ChatImage; projectId?: string | null; alt: string; onClose: () => void }) {
  const { src, failed } = useChatImageSrc(image, projectId, true, false);
  if (!src || failed) return <ImageLightbox src={image.data || ''} alt={alt} onClose={onClose} />;
  return <ImageLightbox src={src} alt={alt} onClose={onClose} />;
}

function ChatMessageImage({ image, projectId }: { image: ChatImage; projectId?: string | null }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const visible = useVisible(anchorRef);
  const { src, failed } = useChatImageSrc(image, projectId, visible, true);
  const [expanded, setExpanded] = useState(false);
  const alt = image.name || 'Attached image';
  return (
    <>
      <button ref={anchorRef} type="button" disabled={!src || failed} onClick={() => setExpanded(true)} aria-label={`Expand ${alt}`} className="block h-28 w-28 overflow-hidden rounded-xl border border-border/50 bg-muted shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60">
        {failed ? <span className="flex h-full items-center justify-center px-2 text-center text-[10px] text-muted-foreground">{alt}</span> : src ? <img src={src} alt={alt} decoding="async" className="h-28 w-28 cursor-zoom-in object-cover transition-transform duration-200 hover:scale-105" /> : <span className="block h-full w-full animate-pulse" />}
      </button>
      {expanded && <OriginalImageLightbox image={image} projectId={projectId} alt={alt} onClose={() => setExpanded(false)} />}
    </>
  );
}

export default function ChatMessageImages({ images, projectId }: ChatMessageImagesProps) {
  if (!images?.length) return null;
  return <div className="flex flex-wrap justify-end gap-2">{images.map((image, index) => <ChatMessageImage key={image.path || image.name || index} image={image} projectId={projectId} />)}</div>;
}
