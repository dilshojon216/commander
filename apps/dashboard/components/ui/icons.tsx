import type { SVGProps } from "react";

/** Dizayndagi 16x16 chiziqli ikonkalar (dekorativ: aria-hidden). */
type P = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

function Svg({ size = 16, strokeWidth = 1.5, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </Svg>
);
export const IconTerminal = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M5 7l2 1.5L5 10" />
  </Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" />
  </Svg>
);
export const IconBars = (p: P) => (
  <Svg {...p}>
    <path d="M3 13V8M6.5 13V4M10 13V7M13.5 13V2" />
  </Svg>
);
export const IconServers = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
    <rect x="2" y="9" width="12" height="4.5" rx="1" />
    <path d="M4.5 4.75h.01M4.5 11.25h.01" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <path d="M10 3L5 8l5 5" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconMenu = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Svg>
);
export const IconAlert = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5v3.5M8 11h.01" />
  </Svg>
);
export const IconStop = (p: P) => (
  <svg width={p.size ?? 12} height={p.size ?? 12} viewBox="0 0 16 16" aria-hidden="true">
    <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
  </svg>
);
export const IconSpinner = (p: P) => (
  <Svg size={12} strokeWidth={1.8} className="spin" {...p}>
    <path d="M14 8a6 6 0 11-2-4.5" />
  </Svg>
);
export const IconSend = (p: P) => (
  <svg width={p.size ?? 26} height={p.size ?? 26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M21 4L3 11l6 2 2 6 3-4 5 4z" />
    <path d="M9 13l12-9" />
  </svg>
);

export const IconMachine = (p: P) => (
  <Svg size={18} strokeWidth={1.4} {...p}>
    <rect x="2" y="2.5" width="12" height="8" rx="1.2" />
    <path d="M6 13.5h4M8 10.5v3" />
  </Svg>
);

/** Operatsion tizim ikonkalari: darwin / linux / win32 (boshqasi: umumiy kompyuter). */
export function OsIcon({ os, size = 18 }: { os: "darwin" | "linux" | "win32" | "other"; size?: number }) {
  if (os === "darwin") {
    return (
      <Svg size={size} strokeWidth={1.4}>
        <rect x="2" y="2.5" width="12" height="8" rx="1.2" />
        <path d="M1.5 13h13M6.5 2.5h3" />
      </Svg>
    );
  }
  if (os === "linux") {
    return (
      <Svg size={size} strokeWidth={1.4}>
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <path d="M5 7l2 1.5L5 10M8.5 10.5H11" />
      </Svg>
    );
  }
  if (os === "win32") {
    return (
      <Svg size={size} strokeWidth={1.4}>
        <path d="M2 3.5l5-.8v5H2zM8 2.6l6-1v6.1H8zM2 8.8h5v4.5l-5-.8zM8 8.8h6v5.8l-6-1z" />
      </Svg>
    );
  }
  return <IconMachine size={size} />;
}

export const IconClock = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.3" />
  </Svg>
);
