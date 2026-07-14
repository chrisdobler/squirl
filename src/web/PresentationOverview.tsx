import React from 'react';

export interface PresentationOverviewProps {
  onStart: () => void;
  mode?: 'landing' | 'surface';
}

const AgentNode = ({ className, eyebrow, title, description }: {
  className: string;
  eyebrow: string;
  title: string;
  description: string;
}) => (
  <article className={`overviewAgentNode ${className}`}>
    <span>{eyebrow}</span>
    <strong>{title}</strong>
    <small>{description}</small>
  </article>
);

export function PresentationOverview({ onStart, mode = 'landing' }: PresentationOverviewProps) {
  return (
    <section className={`presentationOverview presentationOverview--${mode}`} aria-labelledby="overview-title">
      <div className="overviewAtmosphere" aria-hidden="true" />
      <header className="overviewIntro">
        <span className="overviewKicker">One thought. Every capable agent.</span>
        <h1 id="overview-title">Your intent, orchestrated.</h1>
        <p>Squirl carries the shape of what you mean to the agents best equipped to make it real.</p>
      </header>

      <div className="overviewGraph" role="img" aria-label="Your mind and local AI infrastructure connect to Squirl as separate services. Inside Squirl, the orchestrator coordinates a chat model, embedder, and vector database before routing work to agents and connected services including Claude Code, Codex, PI Agent, and Google Calendar.">
        <svg className="overviewConnections" viewBox="0 0 1200 620" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="overviewIntentLine" x1="0" x2="1">
              <stop offset="0" stopColor="#56d7cd" stopOpacity=".24" />
              <stop offset=".55" stopColor="#8df0df" />
              <stop offset="1" stopColor="#f0a94e" />
            </linearGradient>
            <linearGradient id="overviewAgentLine" x1="0" x2="1">
              <stop offset="0" stopColor="#f0a94e" />
              <stop offset="1" stopColor="#8fc9ff" stopOpacity=".6" />
            </linearGradient>
            <linearGradient id="overviewServiceLine" x1="0" x2="1">
              <stop offset="0" stopColor="#6fd0b8" stopOpacity=".65" />
              <stop offset="1" stopColor="#f0a94e" />
            </linearGradient>
            <filter id="overviewLineGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <path className="overviewIntentPath overviewPathGlow" d="M210 310 C315 310 335 310 410 310" />
          <path className="overviewIntentPath" d="M210 310 C315 310 335 310 410 310" />
          <path className="overviewServicePath overviewPathGlow" d="M330 510 C375 510 370 430 410 430" />
          <path className="overviewServicePath" d="M330 510 C375 510 370 430 410 430" />
          <g className="overviewSupportedPaths">
            <path d="M720 310 C795 310 785 90 900 90" />
            <path d="M720 310 C800 310 805 190 900 190" />
            <path d="M720 310 C810 310 825 290 900 290" />
            <path d="M720 310 C810 310 825 390 900 390" />
          </g>
          <g className="overviewFuturePaths">
            <path d="M720 310 C800 310 800 490 900 490" />
            <path d="M720 310 C790 310 780 585 900 585" />
          </g>
          <circle className="overviewSignal overviewSignal--intent" r="5">
            <animateMotion dur="4.8s" repeatCount="indefinite" path="M210 310 C315 310 335 310 410 310" />
          </circle>
          <circle className="overviewSignal overviewSignal--service" r="4">
            <animateMotion dur="5.6s" repeatCount="indefinite" path="M330 510 C375 510 370 430 410 430" />
          </circle>
          <circle className="overviewSignal overviewSignal--one" r="4">
            <animateMotion dur="5.4s" repeatCount="indefinite" path="M720 310 C795 310 785 90 900 90" />
          </circle>
          <circle className="overviewSignal overviewSignal--two" r="4">
            <animateMotion dur="6.7s" repeatCount="indefinite" path="M720 310 C810 310 825 290 900 290" />
          </circle>
        </svg>

        <div className="overviewBrainNode">
          <div className="overviewBrainHalo" aria-hidden="true" />
          <svg className="overviewBrain" viewBox="0 0 180 180" aria-hidden="true">
            <g>
              <path d="M83 32c-17-13-40 1-36 22-18 3-23 27-9 38-13 17-1 40 19 39 4 20 30 23 42 8" />
              <path d="M98 32c16-13 39 1 35 22 19 3 24 27 10 38 13 17 1 40-19 39-4 20-29 23-41 8" />
              <path d="M90 31v116M53 56c18-1 25 12 25 26M37 91c17-6 33 3 36 19M57 130c-2-14 8-23 21-25M128 56c-17-1-25 12-25 26M145 91c-18-6-33 3-36 19M124 130c2-14-8-23-21-25" />
            </g>
          </svg>
          <span>Your mind</span>
          <strong>Intent</strong>
          <small>Ideas · judgment · direction</small>
        </div>

        <div className="overviewSquirlSystem">
          <header>
            <img src="/logo-dark-clean.png" alt="" />
            <div><span>Continuity + orchestration</span><strong>Squirl</strong></div>
          </header>
          <div className="overviewPipelineMap">
            <svg viewBox="0 0 320 360" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id="overviewMapArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
                <marker id="overviewMapArrowMemory" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              <path className="mapFlow mapFlow--model" d="M160 82 C160 116 224 108 224 137" />
              <path className="mapFlow mapFlow--return" d="M270 137 C306 103 300 57 274 57" />
              <path className="mapFlow mapFlow--memory" d="M130 82 C111 145 88 224 82 283" />
              <path className="mapFlow mapFlow--memory" d="M150 309 C157 320 166 320 174 309" />
              <path className="mapFlow mapFlow--recall" d="M240 283 C285 238 301 126 258 80" />
              <text className="mapFlowLabel" x="169" y="116">assembled context</text>
              <text className="mapFlowLabel" x="271" y="106">stream</text>
              <text className="mapFlowLabel" x="52" y="177">meaning</text>
              <text className="mapFlowLabel" x="145" y="340">vectors</text>
              <text className="mapFlowLabel mapFlowLabel--recall" x="252" y="205">recalled context</text>
              <circle className="mapSignal mapSignal--model" r="2.6"><animateMotion dur="4.2s" repeatCount="indefinite" path="M160 82 C160 116 224 108 224 137" /></circle>
              <circle className="mapSignal mapSignal--memory" r="2.6"><animateMotion dur="5.2s" repeatCount="indefinite" path="M130 82 C111 145 88 224 82 283" /></circle>
              <circle className="mapSignal mapSignal--recall" r="2.6"><animateMotion dur="5.8s" repeatCount="indefinite" path="M240 283 C285 238 301 126 258 80" /></circle>
            </svg>
            <article className="overviewMapNode map-orchestrator">
              <span>Runtime</span><strong>Context orchestrator</strong><small>Assembles intent, history, files, and memory</small>
            </article>
            <article className="overviewMapNode map-model">
              <span>Intelligence</span><strong>Chat model</strong><small>Reasons and streams</small>
            </article>
            <article className="overviewMapNode map-embedder">
              <span>Semantic encoding</span><strong>Embedder</strong><small>Meaning into vectors</small>
            </article>
            <article className="overviewMapNode map-vector">
              <span>Durable memory</span><strong>Vector database</strong><small>Relevant history</small>
            </article>
          </div>
          <footer><i aria-hidden="true" /> Context travels with the work</footer>
        </div>

        <aside className="overviewLocalInfra">
          <span>Connected service</span>
          <strong>Local AI infrastructure</strong>
          <div><b>vLLM</b><b>Ollama</b><b>OpenAI-compatible</b></div>
        </aside>

        <div className="overviewAgentStack">
          <AgentNode className="is-live is-claude" eyebrow="Available now" title="Claude Code" description="Deep implementation" />
          <AgentNode className="is-live is-codex" eyebrow="Available now" title="Codex" description="Focused execution" />
          <AgentNode className="is-live is-pi" eyebrow="Available now" title="PI Agent" description="Flexible local specialist" />
          <AgentNode className="is-live is-calendar" eyebrow="Connected integration" title="Google Calendar" description="Organize time and priorities" />
          <AgentNode className="is-future" eyebrow="Extensible" title="Research" description="Find and synthesize" />
          <AgentNode className="is-future" eyebrow="Extensible" title="Custom agent" description="Bring your own specialist" />
        </div>
      </div>

      <footer className="overviewFooter">
        <button type="button" className="overviewStart" onClick={onStart}>
          <span>Start with an idea</span><b aria-hidden="true">→</b>
        </button>
        <p><i aria-hidden="true" /> Squirl keeps the human at the center.</p>
      </footer>
    </section>
  );
}
