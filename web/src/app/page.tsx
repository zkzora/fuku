import Link from "next/link";
import { ArrowRight, Fingerprint, ShieldCheck, Sparkles } from "lucide-react";
import { Logo } from "@/components/brand";
import { Pill } from "@/components/bits";
import { Reveal } from "@/components/landing/reveal";

const SPONSORS = ["Monad", "Mera", "Privy", "Dynamic", "Nansen", "Envio", "Kimi", "Qwen", "Chainlink CRE", "Cleanverse"];

export default function Landing() {
  return (
    <div className="min-h-screen bg-white text-ink">
      <header className="fuku-glass sticky top-0 z-20 border-b border-line">
        <div className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between px-5 md:px-8">
          <Logo />
          <nav className="hidden items-center gap-9 text-[14px] text-ink-2 md:flex">
            <a href="#protocol" className="hover:text-ink">Protocol</a>
            <a href="#developers" className="hover:text-ink">Developers</a>
            <Link href="/developers" className="hover:text-ink">Docs</Link>
            <a href="#ecosystem" className="hover:text-ink">Ecosystem</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/sign-in" className="px-3 text-[14px] text-ink-2 hover:text-ink">Sign in</Link>
            <Link
              href="/sign-in?next=/developers"
              className="rounded-full bg-ink px-[18px] py-2.5 text-[14px] font-medium text-white transition hover:bg-ink-2"
            >
              Build with Fuku
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section
        className="px-5 pb-20 pt-16 md:px-8 md:pt-28"
        style={{ background: "radial-gradient(60% 50% at 50% 0%, rgba(124,92,255,.10), transparent 70%)" }}
      >
        <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-7 text-center">
          <Reveal>
            <Pill tone="violet" className="normal-case tracking-normal text-[13px]">Human-backed AI agent trust · Built on Monad</Pill>
          </Reveal>
          <Reveal delay={0.05}>
            <h1 className="max-w-[900px] text-balance text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] md:text-[76px]">
              The Trust Layer for the AI Economy
            </h1>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="max-w-[620px] text-pretty text-[18px] leading-[1.5] text-ink-3 md:text-[21px]">
              Give humans and AI agents portable identity, reputation, and permissions.
            </p>
          </Reveal>
          <Reveal delay={0.15} className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/sign-in?next=/developers" className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3.5 text-[15px] font-medium text-white transition hover:bg-ink-2">
              Build with Fuku <ArrowRight className="size-4" />
            </Link>
            <Link href="/sign-in" className="inline-flex items-center gap-2 rounded-full bg-surface px-6 py-3.5 text-[15px] font-medium text-ink transition hover:bg-line">
              Open the app
            </Link>
          </Reveal>

          <Reveal delay={0.25} className="mt-8 w-full max-w-[560px]">
            <PassportVisual />
          </Reveal>
        </div>
      </section>

      {/* Sponsors */}
      <section id="ecosystem" className="border-y border-line bg-surface/60 px-5 py-8 md:px-8">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-center gap-x-9 gap-y-3 text-[13px] font-medium text-ink-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">Built with</span>
          {SPONSORS.map((s) => (
            <span key={s} className="text-ink-2">{s}</span>
          ))}
        </div>
      </section>

      {/* Problem */}
      <section className="px-5 py-24 md:px-8">
        <div className="mx-auto grid max-w-[1200px] gap-12 md:grid-cols-[1.1fr_1fr] md:items-center">
          <Reveal>
            <h2 className="text-balance text-[34px] font-semibold leading-[1.08] md:text-[44px]">
              AI agents are about to move money. Nobody knows who&apos;s behind them.
            </h2>
          </Reveal>
          <Reveal delay={0.1} className="space-y-4">
            {[
              "No reliable identity for the human behind an agent.",
              "No portable reputation.",
              "No universal permission framework.",
              "Every application rebuilds its own trust system.",
            ].map((t) => (
              <div key={t} className="flex items-start gap-3 text-[16px] text-ink-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-block" />
                {t}
              </div>
            ))}
            <p className="pt-2 text-[16px] font-medium text-ink">Fuku is the primitive they build on instead.</p>
          </Reveal>
        </div>
      </section>

      {/* Features */}
      <section id="protocol" className="bg-surface/60 px-5 py-24 md:px-8">
        <div className="mx-auto grid max-w-[1200px] gap-5 md:grid-cols-3">
          {[
            {
              icon: <Fingerprint className="size-5 text-violet" />,
              title: "Human Identity",
              body: "Passkey sign-in with WebAuthn. One verified human, provably behind every agent they own.",
              foot: <Pill tone="allow" dot>Human verified</Pill>,
            },
            {
              icon: <ShieldCheck className="size-5 text-violet" />,
              title: "Permission Passport",
              body: "What is this AI allowed to do? Allowances, limits and hard blocks, enforced on-chain, readable by anyone.",
              foot: (
                <div className="flex gap-2">
                  <Pill tone="allow">Allowed</Pill>
                  <Pill tone="block">Blocked</Pill>
                </div>
              ),
            },
            {
              icon: <Sparkles className="size-5 text-violet" />,
              title: "Portable Reputation",
              body: "A trust score built from execution history, violations and security events. It travels with the agent.",
              foot: (
                <div className="text-[28px] font-semibold leading-none text-ink">
                  96<span className="text-[14px] font-medium text-ink-3"> /100</span>
                </div>
              ),
            },
          ].map((f, i) => (
            <Reveal key={f.title} delay={i * 0.08} className="fuku-card flex flex-col gap-4 p-7">
              <span className="grid size-10 place-items-center rounded-xl bg-violet-soft">{f.icon}</span>
              <h3 className="text-[20px] font-semibold">{f.title}</h3>
              <p className="text-pretty text-[15px] leading-[1.55] text-ink-3">{f.body}</p>
              <div className="mt-auto pt-2">{f.foot}</div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Architecture */}
      <section className="px-5 py-24 md:px-8">
        <div className="mx-auto max-w-[900px] text-center">
          <Reveal>
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-violet">Protocol architecture</div>
            <h2 className="mt-3 text-balance text-[34px] font-semibold leading-[1.08] md:text-[44px]">One trust layer. Every app builds on it.</h2>
            <p className="mx-auto mt-4 max-w-[560px] text-pretty text-[16px] text-ink-3">
              Fuku is not a wallet. It sits between applications and Monad as the identity, permission and reputation primitive.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-3">
            <Layer title="Application layer" items={["AI apps", "Wallets", "DeFi", "Marketplaces", "Enterprise"]} />
            <span className="text-ink-3">↓</span>
            <Layer
              title="Fuku Protocol layer"
              accent
              items={["Human Identity Contract", "AI Agent Registry", "Permission Engine", "Reputation System", "Encrypted Data Vault"]}
            />
            <span className="text-ink-3">↓</span>
            <Layer title="Monad" items={["Settlement", "ERC-8004 compatible agent identity"]} />
          </Reveal>
        </div>
      </section>

      {/* Developers */}
      <section id="developers" className="bg-ink px-5 py-24 text-white md:px-8">
        <div className="mx-auto grid max-w-[1200px] items-center gap-12 md:grid-cols-2">
          <Reveal>
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#b3a3ff]">Developer SDK</div>
            <h2 className="mt-3 text-balance text-[34px] font-semibold leading-[1.08] md:text-[44px]">Integrate trust. Skip the infrastructure.</h2>
            <p className="mt-4 max-w-[480px] text-pretty text-[16px] leading-[1.55] text-white/65">
              Five calls cover identity, registration, permissions and scoring. Agent activity indexed by Envio, explained by Kimi/Qwen.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/sign-in?next=/developers" className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-[14px] font-medium text-ink hover:bg-white/90">
                Open developer console <ArrowRight className="size-4" />
              </Link>
              <Link href="/sign-in?next=/developers" className="inline-flex items-center rounded-full px-5 py-3 text-[14px] font-medium text-white/80 hover:text-white">
                Get API keys →
              </Link>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <pre className="mono overflow-x-auto rounded-2xl bg-white/[0.06] p-6 text-[13px] leading-[1.7] text-white/85 ring-1 ring-white/10">
{`const id    = await fuku.createIdentity({ passkey })
const agent = await fuku.registerAgent({
  owner: id, name: 'Trading Assistant'
})
await fuku.requestPermission(agent, {
  allow: ['swap'], limit: 5000, block: ['withdraw']
})
const score = await fuku.getTrustScore(agent) // 96`}
            </pre>
          </Reveal>
        </div>
      </section>

      {/* CTA */}
      <section className="px-5 py-24 md:px-8">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-5 text-center">
          <h2 className="text-balance text-[34px] font-semibold leading-[1.08] md:text-[44px]">Start building on Fuku</h2>
          <p className="max-w-[480px] text-pretty text-[16px] text-ink-3">Documentation, SDK reference and a testnet console.</p>
          <Link href="/sign-in?next=/developers" className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3.5 text-[15px] font-medium text-white hover:bg-ink-2">
            Open documentation <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-line px-5 py-8 text-center text-[13px] text-ink-3 md:px-8">
        © 2026 Fuku Protocol · Built on Monad
      </footer>
    </div>
  );
}

function Layer({ title, items, accent }: { title: string; items: string[]; accent?: boolean }) {
  return (
    <div className={accent ? "fuku-card w-full p-5 ring-violet/30" : "w-full rounded-2xl border border-line p-5"}>
      <div className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${accent ? "text-violet" : "text-ink-3"}`}>{title}</div>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {items.map((i) => (
          <span key={i} className={`rounded-full px-3 py-1.5 text-[13px] font-medium ${accent ? "bg-violet-soft text-ink" : "bg-surface text-ink-2"}`}>
            {i}
          </span>
        ))}
      </div>
    </div>
  );
}

function PassportVisual() {
  return (
    <div className="fuku-card p-6 text-left">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-ink-3">Agent Permission Passport</div>
        <Pill tone="allow" dot>Verified human owner</Pill>
      </div>
      <div className="mt-5 flex items-center gap-4">
        <span className="grid size-12 place-items-center rounded-xl bg-violet-soft text-[18px] font-semibold text-violet">T</span>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold">Trading Assistant</div>
          <div className="mono truncate text-[12.5px] text-ink-3">fuku:agent:0x7a3f…9c21</div>
        </div>
        <div className="text-right">
          <div className="text-[28px] font-semibold leading-none">96</div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Trust score</div>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-allow-soft p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-allow">Allowed</div>
          <div className="mt-1 text-[14px] font-medium">Swap assets</div>
        </div>
        <div className="rounded-xl bg-surface p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Limit</div>
          <div className="mt-1 text-[14px] font-medium">5,000 USDC / day</div>
        </div>
        <div className="rounded-xl bg-block-soft p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-block">Blocked</div>
          <div className="mt-1 text-[14px] font-medium">Withdraw funds</div>
        </div>
      </div>
    </div>
  );
}
