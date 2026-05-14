import { useState, useCallback, useEffect } from "react";

const SCROLL_THRESHOLD = 100; // 像素

interface UseScrollOptions {
  threshold?: number;
}

export function useScroll(options: UseScrollOptions = {}) {
  const threshold = options.threshold ?? SCROLL_THRESHOLD;
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  // 判断用户是否接近文档底部（整页滚动）
  const isNearBottom = useCallback(() => {
    const scrollTop = window.scrollY;
    const scrollHeight = document.documentElement.scrollHeight;
    const clientHeight = window.innerHeight;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, [threshold]);

  // 滚动到文档底部
  const scrollToBottom = useCallback(() => {
    if (!autoScrollEnabled) return;

    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "smooth",
    });
  }, [autoScrollEnabled]);

  const handleScroll = useCallback(() => {
    if (isNearBottom()) {
      setAutoScrollEnabled(true);
    } else {
      setAutoScrollEnabled(false);
    }
  }, [isNearBottom]);

  useEffect(() => {
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  return {
    autoScrollEnabled,
    setAutoScrollEnabled,
    scrollToBottom,
    isNearBottom,
  };
}
