import type { MailSource } from "../data/mailData";

export function CollectorMark({ className = "" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 44 44" aria-hidden="true"><rect width="44" height="44" rx="14" fill="currentColor" /><path d="M11.5 15.5 22 23l10.5-7.5M12 16v13h20V16" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M16 11.5h12" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".65" /></svg>;
}

export function GmailLogo({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 36" aria-hidden="true">
      <path fill="#4285f4" d="M4 34h8V14L4 8z" />
      <path fill="#34a853" d="M36 34h8V8l-8 6z" />
      <path fill="#fbbc04" d="M4 8v-2c0-3.1 3.6-4.8 6-2.9L24 13.5 38 3.1c2.4-1.9 6-.2 6 2.9v2L24 23z" />
      <path fill="#ea4335" d="M4 8l20 15 20-15v8L24 31 4 16z" />
    </svg>
  );
}

export function AccountBrand({ source, className = "" }: { source: MailSource; className?: string }) {
  if (source === "gmail") return <GmailLogo className={className} />;
  if (source === "outlook") {
    return (
      <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
        <rect x="2" y="6" width="15" height="21" rx="1.5" fill="#1473e6" />
        <path fill="#fff" d="M9.5 11c-3 0-4.8 2.2-4.8 5.3 0 3 1.8 5.2 4.7 5.2 3 0 4.9-2.2 4.9-5.4 0-2.9-1.8-5.1-4.8-5.1zm0 2.2c1.5 0 2.3 1.3 2.3 3 0 1.9-.8 3.1-2.3 3.1s-2.3-1.3-2.3-3.1c0-1.7.8-3 2.3-3z" />
        <path fill="#28a8ea" d="M17 9h13v16H17z" />
        <path fill="#50d1f5" d="m17 9 6.5 5L30 9z" />
        <path fill="#0f5fbf" d="m17 25 6.5-5L30 25z" />
      </svg>
    );
  }
  if (source === "qq") return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="5" width="26" height="22" rx="4" fill="#f6b900" />
      <path fill="#fff" d="m6 9 10 8 10-8v3L16 20 6 12z" />
      <path fill="#df8b00" d="m5 25 8-8 3 2.5 3-2.5 8 8z" opacity=".75" />
    </svg>
  );
  const color = source === "icloud" ? "#7b8a9a" : source === "netease" ? "#d93025" : "#5f6368";
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="6" width="26" height="20" rx="3.5" fill={color} opacity=".14" />
      <path d="m5.5 9 10.5 8 10.5-8M5.5 24l7.8-7M26.5 24l-7.8-7" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GoogleWordmark() {
  return (
    <div className="google-wordmark" aria-label="Google">
      <span className="g-blue">G</span><span className="g-red">o</span><span className="g-yellow">o</span><span className="g-blue">g</span><span className="g-green">l</span><span className="g-red">e</span>
    </div>
  );
}
