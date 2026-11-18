/** Small inline stroke icons (24x24), so the app needs no icon font or external library. */
type P = { size?: number };
const S = ({ size = 22, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const MicIcon = (p: P) => (
  <S {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </S>
);
export const StopIcon = (p: P) => (
  <S {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M17 9l4 6M21 9l-4 6" />
  </S>
);
export const ScreenIcon = (p: P) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </S>
);
export const EyeIcon = (p: P) => (
  <S {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </S>
);
export const SendIcon = (p: P) => (
  <S {...p}>
    <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" />
  </S>
);
export const GearIcon = (p: P) => (
  <S {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8M4 12h2M10 12h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
    <circle cx="8" cy="12" r="2" />
  </S>
);
export const CameraIcon = (p: P) => (
  <S {...p}>
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </S>
);
export const CloseIcon = (p: P) => (
  <S {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </S>
);
export const RoseIcon = (p: P) => (
  <S {...p}>
    <path d="M12 21v-7" />
    <path d="M12 14c-3.5 0-5.5-2.5-5.5-5.5C8 9.5 10 9 12 7c2 2 4 2.5 5.5 1.5 0 3-2 5.5-5.5 5.5z" />
    <path d="M9 4.5c1 .8 2 .9 3 .5 1 .4 2 .3 3-.5" />
    <path d="M12 18c-1.5-1.5-3.5-1.5-4.5-.5M12 17c1.5-1.2 3.2-1.2 4.2-.2" />
  </S>
);
export const VideoIcon = (p: P) => (
  <S {...p}>
    <rect x="3" y="6" width="13" height="12" rx="2.5" />
    <path d="M16 10.5l5-3v9l-5-3z" />
  </S>
);
