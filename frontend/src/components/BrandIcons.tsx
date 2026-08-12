import type { MailSource } from "../data/mailData";

export function CollectorMark({ className = "" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 44 44" aria-hidden="true"><rect width="44" height="44" rx="14" fill="currentColor" /><path d="M11.5 15.5 22 23l10.5-7.5M12 16v13h20V16" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M16 11.5h12" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".65" /></svg>;
}

export function AccountBrand({ source, className = "" }: { source: MailSource; className?: string }) {
  if (source === "other") {
    return (
      <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="6" width="26" height="20" rx="3.5" fill="#5f6368" opacity=".14" />
        <path d="m5.5 9 10.5 8 10.5-8M5.5 24l7.8-7M26.5 24l-7.8-7" fill="none" stroke="#5f6368" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return <img className={className} src={`/icons/${source}.svg`} alt="" aria-hidden="true" />;
}

export function GoogleWordmark() {
  return (
    <div className="google-wordmark" aria-label="Google">
      <span className="g-blue">G</span><span className="g-red">o</span><span className="g-yellow">o</span><span className="g-blue">g</span><span className="g-green">l</span><span className="g-red">e</span>
    </div>
  );
}
