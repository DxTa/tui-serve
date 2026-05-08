import { useEffect, useState } from 'react';

export function useVisualViewportHeight(onChange?: () => void) {
  const [visualViewportHeight, setVisualViewportHeight] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.visualViewport?.height ?? window.innerHeight;
  });

  useEffect(() => {
    const updateVisualViewportHeight = () => {
      setVisualViewportHeight(window.visualViewport?.height ?? window.innerHeight);
      onChange?.();
    };

    updateVisualViewportHeight();
    window.visualViewport?.addEventListener('resize', updateVisualViewportHeight);
    window.visualViewport?.addEventListener('scroll', updateVisualViewportHeight);
    window.addEventListener('resize', updateVisualViewportHeight);

    return () => {
      window.visualViewport?.removeEventListener('resize', updateVisualViewportHeight);
      window.visualViewport?.removeEventListener('scroll', updateVisualViewportHeight);
      window.removeEventListener('resize', updateVisualViewportHeight);
    };
  }, [onChange]);

  return visualViewportHeight;
}
