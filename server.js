'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  phase: 'presenting',         // 'presenting' | 'voting' | 'winner'
  currentSection: 'intro',
  currentPageIndex: 0,
  visitedSections: [],
  votes: {},                   // ip → sectionId
  voteOptions: [],
  votingOpen: false,
  winnerSection: null,
  navHistory: [],              // [{section, pageIndex}] for back-across-sections
};

function resetState() {
  state.phase = 'presenting';
  state.currentSection = 'intro';
  state.currentPageIndex = 0;
  state.visitedSections = [];
  state.votes = {};
  state.navHistory = [];
  state.voteOptions = [];
  state.votingOpen = false;
  state.winnerSection = null;
}

// ─── SSE clients ──────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

function broadcastState() {
  const voteCounts = {};
  for (const opt of state.voteOptions) voteCounts[opt.id] = 0;
  for (const v of Object.values(state.votes)) {
    if (voteCounts[v] !== undefined) voteCounts[v]++;
  }
  broadcast({
    type: 'state',
    phase: state.phase,
    section: state.currentSection,
    pageIndex: state.currentPageIndex,
    votingOpen: state.votingOpen,
    voteOptions: state.voteOptions,
    voteCounts,
    winnerSection: state.winnerSection,
  });
}

// ─── Sections / pages ─────────────────────────────────────────────────────────
const SECTIONS = ['intro', 'tools', 'rules', 'skills', 'build', 'qa'];
const MODULE_SECTIONS = ['tools', 'rules', 'skills', 'build'];

function pagesFor(sectionId) {
  return PAGES[sectionId] || [];
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ─── Branch options ───────────────────────────────────────────────────────────
const BRANCH_OPTIONS = {
  tools: { id: 'tools', label: 'TOOLKIT', color: '#38BDF8', desc: 'What\'s approved + what\'s already deployed at Upbound' },
  rules: { id: 'rules', label: 'RULES',   color: '#EF4444', desc: '3 rules to keep you safe — no lecture, just the guardrails' },
  skills:{ id: 'skills',label: 'SKILLS',  color: '#84CC16', desc: 'What you can actually DO + a prompting framework' },
  build: { id: 'build', label: 'BUILD',   color: '#EAB308', desc: 'Skip to the demo — let\'s make an agent right now' },
  qa:    { id: 'qa',    label: 'HEAD TO Q&A', color: '#A78BFA', desc: 'Wrap up and open the floor' },
};

function buildBranchOptions(branchNum) {
  const opts = [];
  const visited = state.visitedSections;
  if (branchNum === 1) {
    return [BRANCH_OPTIONS.tools, BRANCH_OPTIONS.rules, BRANCH_OPTIONS.skills, BRANCH_OPTIONS.build];
  }
  // branch 2+: unvisited modules + always qa
  for (const id of ['tools','rules','skills','build']) {
    if (!visited.includes(id)) opts.push(BRANCH_OPTIONS[id]);
  }
  opts.push(BRANCH_OPTIONS.qa);
  return opts;
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function pushHistory() {
  state.navHistory.push({ section: state.currentSection, pageIndex: state.currentPageIndex });
}

function advanceNext() {
  // Branch pages: → opens vote if not open, otherwise no-op (must use C to close)
  if (state.currentSection.startsWith('branch')) {
    if (!state.votingOpen) openVote();
    return;
  }

  const pages = pagesFor(state.currentSection);
  if (state.currentPageIndex < pages.length - 1) {
    pushHistory();
    state.currentPageIndex++;
  } else {
    // end of section
    pushHistory();
    if (state.currentSection === 'intro') {
      openBranch(1);
    } else if (MODULE_SECTIONS.includes(state.currentSection)) {
      if (!state.visitedSections.includes(state.currentSection)) {
        state.visitedSections.push(state.currentSection);
      }
      const unvisited = MODULE_SECTIONS.filter(s => !state.visitedSections.includes(s));
      if (unvisited.length === 0) {
        goToSection('qa');
      } else {
        openBranch(2);
      }
    }
    // qa: no-op at end
  }
  broadcastState();
}

function advancePrev() {
  if (state.currentPageIndex > 0) {
    state.currentPageIndex--;
  } else if (state.navHistory.length > 0) {
    // cross section boundary — restore last position
    const prev = state.navHistory.pop();
    state.currentSection = prev.section;
    state.currentPageIndex = prev.pageIndex;
    state.phase = 'presenting';
    state.votingOpen = false;
    state.winnerSection = null;
    // restore voteOptions if going back to a branch
    if (state.currentSection.startsWith('branch')) {
      const num = parseInt(state.currentSection.replace('branch', ''), 10);
      state.voteOptions = buildBranchOptions(num);
    }
  }
  broadcastState();
}

function openBranch(num) {
  const opts = buildBranchOptions(num);
  if (opts.length === 1 && opts[0].id !== 'qa') {
    goToSection(opts[0].id);
    return;
  }
  state.currentSection = `branch${num}`;
  state.currentPageIndex = 0;
  state.voteOptions = opts;
  state.votes = {};
  state.votingOpen = false;
  state.phase = 'presenting';
}

function goToSection(sectionId) {
  state.currentSection = sectionId;
  state.currentPageIndex = 0;
  state.phase = 'presenting';
  state.votingOpen = false;
  state.winnerSection = null;
}

function openVote() {
  if (!state.currentSection.startsWith('branch')) return;
  state.votingOpen = true;
  state.phase = 'voting';
  state.votes = {};
  broadcastState();
}

function closeVote() {
  if (!state.votingOpen) return;
  state.votingOpen = false;
  // tally
  const counts = {};
  for (const opt of state.voteOptions) counts[opt.id] = 0;
  for (const v of Object.values(state.votes)) {
    if (counts[v] !== undefined) counts[v]++;
  }
  let winner = state.voteOptions[0].id;
  let max = -1;
  for (const [id, cnt] of Object.entries(counts)) {
    if (cnt > max) { max = cnt; winner = id; }
  }
  state.winnerSection = winner;
  state.phase = 'winner';
  broadcastState();
  // After 2.5s auto-advance
  setTimeout(() => {
    goToSection(winner);
    broadcastState();
  }, 2500);
}

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  bg: '#0A0F1E', card: '#111827', border: '#1E293B',
  green: '#84CC16', dkgrn: '#0A1505', white: '#F8FAFC',
  muted: '#64748B', blue: '#38BDF8', red: '#EF4444',
  yellow: '#EAB308', purple: '#A78BFA', teal: '#34D399', footer: '#060A12',
};

// ─── Page HTML generators ─────────────────────────────────────────────────────
function pageIntro1() {
  return `
<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;gap:24px;">
  <div style="font-size:clamp(48px,8vw,96px);font-weight:900;color:${C.white};letter-spacing:-2px;line-height:1;">AI AT WORK</div>
  <div style="font-size:clamp(16px,2.5vw,28px);color:${C.muted};font-style:italic;max-width:700px;">Practical Ways to Leverage AI Every Day</div>
  <div style="font-size:clamp(14px,1.8vw,20px);color:${C.green};font-weight:600;letter-spacing:1px;">Yves Hughes &nbsp;|&nbsp; Senior Product Manager &nbsp;|&nbsp; RAC Acquisition</div>
  <div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap;justify-content:center;">
    ${['60 MIN','HANDS-ON','CHOOSE YOUR ADVENTURE'].map(b=>`<span style="border:1px solid ${C.border};padding:8px 20px;border-radius:4px;font-size:13px;letter-spacing:2px;color:${C.muted};">${b}</span>`).join('')}
  </div>
  <div style="margin-top:32px;font-size:13px;color:${C.muted};letter-spacing:2px;">RAC ACQUISITION LUNCH &amp; LEARN</div>
</div>`;
}

function pageIntro2() {
  return `
<div style="display:flex;gap:32px;height:100%;padding:0 8px;align-items:center;">
  <div style="width:30%;display:flex;flex-direction:column;gap:14px;align-items:flex-start;">
    <div style="font-size:22px;font-weight:700;color:${C.white};">Yves Hughes</div>
    <div style="font-size:14px;color:${C.green};">Senior Product Manager</div>
    <div style="font-size:13px;color:${C.muted};">RAC Acquisition - Commerce Experience</div>
    <img src="/img/headshot.jpg" style="width:160px;height:160px;object-fit:cover;border-radius:8px;border:2px solid ${C.border};display:block;" onerror="this.style.display='none'">
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${['BFA Web Design','MBA Technology Mgmt','MS Data Science &amp; ML'].map(b=>`<span style="border:1px solid ${C.blue};color:${C.blue};padding:4px 10px;border-radius:4px;font-size:11px;letter-spacing:.5px;">${b}</span>`).join('')}
    </div>
    <div style="font-size:12px;color:${C.muted};">yves.hughes@upbound.com</div>
  </div>
  <div style="flex:1;display:flex;flex-direction:column;gap:20px;">
    <div>
      <div style="font-size:clamp(20px,2.5vw,32px);font-weight:700;color:${C.white};margin-bottom:4px;">How I Use AI Every Day</div>
      <div style="font-size:13px;color:${C.muted};font-style:italic;">AT&amp;T | Salesforce | Intuit | Upbound — 10+ years in product</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${[
        'Draft PRDs, specs &amp; stakeholder updates — cuts my writing time in half',
        'Research competitive products &amp; market trends without spending hours on Google',
        'Built a daily AI digest that auto-surfaces my priorities every morning',
        'Compete in hackathons — have won competitions from Meta, Coinbase &amp; Google',
        'Co-host Rewired, a training program teaching executives to rethink AI',
      ].map((t,i)=>`
      <div style="display:flex;align-items:flex-start;gap:14px;">
        <span style="background:${C.blue};color:#000;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:700;min-width:24px;text-align:center;">${String(i+1).padStart(2,'0')}</span>
        <span style="font-size:clamp(13px,1.4vw,16px);color:${C.white};line-height:1.5;">${t}</span>
      </div>`).join('')}
    </div>
  </div>
</div>`;
}

function pageIntro3() {
  const terms = [
    { badge:'AI', name:'Artificial Intelligence', color:C.green, def:'The umbrella term for machines that perform tasks requiring human-like intelligence — understanding language, recognizing patterns, making decisions. Claude, Copilot, and Gemini are all AI.' },
    { badge:'LLM', name:'Large Language Model', color:C.blue, def:'The engine under the hood of Claude, Copilot, and Gemini. Trained on vast amounts of text to understand and generate human language. When you type a prompt, an LLM predicts the best response.' },
    { badge:'AGENT', name:'AI Agent', color:C.purple, def:'AI that doesn\'t just answer questions — it takes actions. An agent can plan steps, use tools, and complete multi-step tasks on your behalf. The morning digest we\'ll build today is a simple agent.' },
    { badge:'VC', name:'Vibe Coding', color:C.yellow, def:'Building software by describing what you want in plain English and letting AI write the code. No traditional programming required. The polling tool in this room right now? Built that way.' },
    { badge:'HALL', name:'AI Hallucination', color:C.red, def:'When AI generates confident, specific, plausible-sounding information that is simply wrong. Dates, names, statistics — all can be fabricated. This is why you always review before you use.' },
    { badge:'PROMPT', name:'The Prompt', color:C.teal, def:'The instruction you give to AI. Everything you type into Claude or Copilot is a prompt. The quality of your prompt directly determines the quality of your output.' },
  ];
  return `
<div style="display:flex;flex-direction:column;gap:16px;height:100%;">
  <div>
    <div style="font-size:clamp(18px,2.5vw,28px);font-weight:700;color:${C.white};">The Language of AI — Key Terms</div>
    <div style="font-size:14px;color:${C.muted};margin-top:4px;">Before we dive in, let's get everyone on the same page</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;flex:1;">
    ${terms.map(t=>`
    <div style="background:${C.card};border:1px solid ${C.border};border-radius:8px;overflow:hidden;display:flex;flex-direction:column;">
      <div style="height:4px;background:${t.color};"></div>
      <div style="padding:14px 16px;display:flex;align-items:center;gap:10px;">
        <span style="background:${t.color};color:#000;font-weight:700;padding:3px 8px;border-radius:4px;font-size:11px;letter-spacing:.5px;">${t.badge}</span>
        <span style="font-weight:600;color:${C.white};font-size:14px;">${t.name}</span>
      </div>
      <div style="height:1px;background:${C.border};"></div>
      <div style="padding:12px 16px;font-size:12px;color:${C.muted};line-height:1.6;flex:1;">${t.def}</div>
    </div>`).join('')}
  </div>
</div>`;
}

function pageBranch(num, baseURL) {
  const opts = state.voteOptions.length ? state.voteOptions : buildBranchOptions(num);
  const q = num === 1 ? "What do y'all want to cover first?" : "What's next?";
  const voteURL = `${baseURL}/vote`;
  return `
<div style="display:flex;gap:32px;height:100%;align-items:center;justify-content:center;">
  <div style="flex:1;display:flex;flex-direction:column;gap:20px;max-width:680px;">
    <div style="font-size:clamp(22px,3.5vw,42px);font-weight:800;color:${C.white};">${q}</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;">
      ${opts.map(o=>`
      <div style="background:${C.card};border:2px solid ${o.color}33;border-radius:10px;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-size:22px;font-weight:700;color:${o.color};margin-bottom:4px;">${o.label}</div>
          <div style="font-size:15px;color:${C.muted};">${o.desc}</div>
        </div>
        <div style="color:${o.color};font-size:22px;opacity:.5;">&rarr;</div>
      </div>`).join('')}
    </div>
  </div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:14px;flex-shrink:0;">
    <div style="font-size:16px;color:${C.muted};letter-spacing:1px;text-transform:uppercase;">Scan to vote</div>
    <div id="qr-box" style="background:#fff;padding:12px;border-radius:10px;"></div>
    <div style="font-family:Consolas,monospace;font-size:14px;color:${C.green};background:${C.card};border:1px solid ${C.border};padding:8px 18px;border-radius:6px;">${voteURL}</div>
  </div>
</div>
<script>
(function(){
  const url = ${JSON.stringify(voteURL)};
  const box = document.getElementById('qr-box');
  if(!box) return;
  if(typeof qrcode === 'undefined'){ box.innerHTML='<div style="color:#888;font-size:12px;padding:20px;">QR unavailable</div>'; return; }
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  box.innerHTML = qr.createImgTag(5, 8);
})();
</script>`;
}

function pageTools1() {
  const cols = [
    { label:'CUSTOMER-FACING', color:C.blue, items:[
      { name:'SF Agentforce', desc:'AI-powered SMS responses &amp; product recs for customers' },
      { name:'Conversational Commerce', desc:'AI chat on rentacenter.com for self-service support' },
      { name:'Google Vertex AI', desc:'Smarter product search via semantic understanding' },
    ]},
    { label:'INTERNAL OPERATIONS', color:C.green, items:[
      { name:'GitHub Copilot', desc:'Helps engineers write &amp; review code faster (* Pending full TPRM approval)' },
      { name:'Marketing AI', desc:'Scales content creation across email, web &amp; social' },
      { name:'Securiti AI', desc:'Automates privacy compliance workflows' },
    ]},
    { label:'DATA &amp; INSIGHTS', color:C.yellow, items:[
      { name:'Placer.AI', desc:'Visitor demographics for RAC store planning' },
      { name:'Sigmund Engine', desc:'AI-enhanced leasability &amp; invoice reading' },
      { name:'AI Innovation Center', desc:'Internal sandbox — open to all, register via intranet' },
    ]},
  ];
  return `
<div style="display:flex;flex-direction:column;gap:16px;height:100%;">
  <div>
    <div style="font-size:clamp(18px,2.5vw,28px);font-weight:700;color:${C.white};">AI at Upbound — Already in Production</div>
    <div style="font-size:14px;color:${C.muted};margin-top:4px;">You might not have realized it — but AI is already part of how we work</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;flex:1;">
    ${cols.map(col=>`
    <div style="background:${C.card};border:1px solid ${C.border};border-radius:8px;overflow:hidden;display:flex;flex-direction:column;">
      <div style="height:4px;background:${col.color};"></div>
      <div style="padding:14px 16px 10px;font-size:11px;font-weight:700;letter-spacing:2px;color:${col.color};">${col.label}</div>
      <div style="display:flex;flex-direction:column;gap:10px;padding:0 16px 16px;flex:1;">
        ${col.items.map(it=>`
        <div style="border-left:3px solid ${col.color}33;padding-left:10px;">
          <div style="font-size:14px;font-weight:600;color:${C.white};">${it.name}</div>
          <div style="font-size:12px;color:${C.muted};margin-top:2px;">${it.desc}</div>
        </div>`).join('')}
      </div>
    </div>`).join('')}
  </div>
  <div style="font-size:11px;color:${C.muted};">Source: Upbound 90-Day AI Literacy Program</div>
</div>`;
}

function pageTools2() {
  return `
<div style="display:flex;flex-direction:column;gap:14px;height:100%;">
  <div>
    <div style="font-size:clamp(18px,2.5vw,28px);font-weight:700;color:${C.white};">Your Approved AI Toolkit</div>
    <div style="font-size:14px;color:${C.muted};margin-top:4px;">Use only company-sponsored accounts — personal accounts are not permitted</div>
  </div>
  <div style="background:#052005;border:1px solid ${C.green}44;border-radius:6px;padding:8px 16px;font-size:12px;font-weight:700;letter-spacing:1px;color:${C.green};">APPROVED — Reviewed &amp; cleared by Third-Party Risk Management</div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
    ${[
      { name:'CLAUDE', sub:'Anthropic', color:C.green, desc:'General productivity, drafting, research, long-doc analysis. Data restrictions apply.' },
      { name:'COPILOT', sub:'Microsoft', color:C.blue, desc:'Enterprise-licensed. Integrated with M365: Outlook, Teams, Word, Excel. Safest daily choice.' },
      { name:'GEMINI', sub:'Google', color:C.yellow, desc:'General productivity. No confidential or customer data. Review all outputs before use.' },
      { name:'BASE44', sub:'No-code Builder', color:C.purple, desc:'AI-powered app builder. Low risk, non-PII only. Great for quick internal tools.' },
    ].map(t=>`
    <div style="background:${C.card};border:1px solid ${t.color}44;border-radius:8px;padding:14px;">
      <div style="font-size:16px;font-weight:700;color:${t.color};">${t.name}</div>
      <div style="font-size:11px;color:${C.muted};margin-bottom:8px;">${t.sub}</div>
      <div style="font-size:12px;color:${C.white};line-height:1.5;">${t.desc}</div>
    </div>`).join('')}
  </div>
  <div style="background:#1a1000;border:1px solid ${C.yellow}44;border-radius:6px;padding:8px 16px;font-size:12px;font-weight:700;letter-spacing:1px;color:${C.yellow};">PENDING — Under Third-Party Risk Management review — not yet cleared</div>
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;">
    ${[
      { name:'GitHub Copilot', desc:'Engineering-focused. Requires manager approval + Working Group review.' },
      { name:'Microsoft Copilot (some integrations)', desc:'Specialist integrations under review.' },
    ].map(t=>`
    <div style="background:${C.card};border:1px solid ${C.yellow}22;border-radius:8px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;">
      <span style="color:${C.yellow};font-size:14px;margin-top:1px;">&#9888;</span>
      <div><div style="font-size:14px;font-weight:600;color:${C.white};">${t.name}</div><div style="font-size:12px;color:${C.muted};margin-top:2px;">${t.desc}</div></div>
    </div>`).join('')}
  </div>
  <div style="background:#1a0000;border:1px solid ${C.red}44;border-radius:6px;padding:8px 16px;font-size:12px;color:${C.red};"><strong>PROHIBITED:</strong> Personal / free accounts: personal ChatGPT, personal Gemini, unapproved tools</div>
  <div style="font-size:11px;color:${C.muted};">Questions? Contact: AIGroup@upbound.com | Full list: intranet.upbound.com/ai-governance &nbsp;|&nbsp; Source: AI Guidelines for Innovation</div>
</div>`;
}

function pageRules1() {
  const cards = [
    { color:C.red, title:'NO RESTRICTED DATA', body:'Never enter SSNs, bank accounts, CRA data, health info, precise geolocation, race/ethnicity, or any PII into any AI tool. Not Claude. Not Copilot. Not any tool.' },
    { color:C.yellow, title:'REVIEW BEFORE YOU USE', body:'You own the output. AI can hallucinate — confidently wrong facts, biased reasoning, IP issues. Always read it before sending, publishing, or acting on it.' },
    { color:C.blue, title:'COMPANY ACCOUNTS ONLY', body:'Personal or free accounts are prohibited. Company data must stay in company-sponsored tools only. Shadow AI = policy violation.' },
  ];
  return `
<div style="display:flex;flex-direction:column;gap:20px;height:100%;justify-content:center;">
  <div>
    <div style="font-size:clamp(18px,2.5vw,28px);font-weight:700;color:${C.white};">Know the Boundaries</div>
    <div style="font-size:14px;color:${C.muted};margin-top:4px;">Three rules to remember | Full policy on InfoSecurity portal</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;flex:1;max-height:300px;">
    ${cards.map(c=>`
    <div style="background:${C.card};border:1px solid ${c.color}44;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;">
      <div style="height:6px;background:${c.color};"></div>
      <div style="padding:20px 22px;display:flex;flex-direction:column;gap:12px;flex:1;">
        <div style="font-size:16px;font-weight:800;color:${c.color};letter-spacing:.5px;">${c.title}</div>
        <div style="font-size:13px;color:${C.white};line-height:1.7;">${c.body}</div>
      </div>
    </div>`).join('')}
  </div>
  <div style="background:${C.dkgrn};border:1px solid ${C.green}44;border-radius:6px;padding:12px 20px;font-size:13px;color:${C.green};">
    Full policy: raccorp.sharepoint.com/sites/InfoSecurity &nbsp;|&nbsp; Questions: AIGroup@upbound.com
  </div>
  <div style="font-size:11px;color:${C.muted};">Source: Gen AI Tools &amp; Technologies Standard (CP-404)</div>
</div>`;
}

function pageSkills1() {
  const items = [
    { n:'01', title:'WRITE &amp; DRAFT', sub:'Specs, emails, briefs', prompt:'"You are a Growth PM. Write a 3-sentence re-engagement email for someone who clicked Get Approved but didn\'t finish. Warm, mobile-optimized."' },
    { n:'02', title:'RESEARCH', sub:'Competitive intel, trends', prompt:'"Summarize the top 3 ways Progressive Leasing markets to first-time buyers. Use plain language, no jargon. Give me 5 bullet points."' },
    { n:'03', title:'BRAINSTORM', sub:'Hypotheses, ideas, angles', prompt:'"Give me 5 A/B test ideas to improve CTA click rate on a lease-to-own checkout page. Include a one-line hypothesis for each."' },
    { n:'04', title:'ANALYZE &amp; SUMMARIZE', sub:'Data, docs, meetings', prompt:'"Here are my weekly KPIs: [paste]. Write a 2-paragraph narrative for my VP — what\'s working, what needs attention, one recommendation."' },
    { n:'05', title:'TRANSLATE', sub:'Localize content fast', prompt:'"Translate this customer email into Spanish. Keep the tone warm and casual. Flag any phrases that don\'t translate well."' },
    { n:'06', title:'BUILD AGENTS', sub:'Automate recurring work', prompt:'"Create a scheduled agent that runs every Monday morning and summarizes my top 3 priorities for the week. Format as a bullet list."' },
  ];
  return `
<div style="display:flex;flex-direction:column;gap:14px;height:100%;">
  <div>
    <div style="font-size:clamp(16px,2.2vw,26px);font-weight:800;color:${C.green};letter-spacing:1px;">GREEN ZONE — TRY THESE RIGHT NOW</div>
    <div style="font-size:13px;color:${C.muted};margin-top:4px;">What you can do in Claude Desktop today — with example prompts</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;flex:1;">
    ${items.map(it=>`
    <div style="background:${C.card};border:1px solid ${C.border};border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="background:${C.green};color:#000;font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;">${it.n}</span>
        <span style="font-size:14px;font-weight:700;color:${C.white};">${it.title}</span>
      </div>
      <div style="font-size:11px;color:${C.muted};font-style:italic;">${it.sub}</div>
      <div style="background:#0d1a06;border:1px solid ${C.green}22;border-radius:4px;padding:10px;font-family:Consolas,monospace;font-size:11px;color:${C.green};line-height:1.5;flex:1;">${it.prompt}</div>
    </div>`).join('')}
  </div>
  <div style="font-size:11px;color:${C.muted};">Source: Gen AI Tools &amp; Technologies Standard (CP-404)</div>
</div>`;
}

function pageSkills2() {
  return `
<div style="display:flex;flex-direction:column;gap:18px;height:100%;justify-content:center;">
  <div>
    <div style="font-size:clamp(18px,2.5vw,30px);font-weight:800;color:${C.white};">Prompting 101</div>
    <div style="font-size:14px;color:${C.muted};font-style:italic;margin-top:4px;">The quality of your output depends on the quality of your input</div>
  </div>
  <div style="background:${C.dkgrn};border:1px solid ${C.green};border-radius:8px;padding:16px 24px;text-align:center;">
    <span style="font-size:clamp(14px,2vw,22px);font-weight:700;color:${C.green};">Great Prompt &nbsp;=&nbsp; Role &nbsp;+&nbsp; Task &nbsp;+&nbsp; Context &nbsp;+&nbsp; Format</span>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;flex:1;max-height:320px;">
    <div style="background:${C.card};border:2px solid ${C.red}44;border-radius:8px;padding:18px 20px;display:flex;flex-direction:column;gap:10px;">
      <div style="font-size:13px;font-weight:700;color:${C.red};letter-spacing:1px;">WEAK PROMPT</div>
      <div style="background:#1a0000;border:1px solid ${C.red}33;border-radius:4px;padding:12px;font-family:Consolas,monospace;font-size:13px;color:${C.white};">"Write me a marketing email."</div>
      <div style="font-size:13px;color:${C.muted};line-height:1.6;">No role, no audience, no context. AI has to guess everything — results will be generic and unusable.</div>
      <div style="font-size:12px;color:${C.red};">Missing: Who are you? &nbsp;Who is this for? &nbsp;What tone? &nbsp;What length?</div>
    </div>
    <div style="background:${C.card};border:2px solid ${C.green}44;border-radius:8px;padding:18px 20px;display:flex;flex-direction:column;gap:10px;">
      <div style="font-size:13px;font-weight:700;color:${C.green};letter-spacing:1px;">STRONG PROMPT</div>
      <div style="background:${C.dkgrn};border:1px solid ${C.green}33;border-radius:4px;padding:12px;font-family:Consolas,monospace;font-size:12px;color:${C.green};line-height:1.6;">"You are a Growth PM at a lease-to-own company. Write a 3-sentence email to a prospective customer who clicked our Get Approved CTA but did not complete the application. Warm, clear, mobile-optimized."</div>
      <div style="font-size:13px;color:${C.green};font-weight:600;">Role + Task + Context + Format &rarr; AI knows exactly what you need.</div>
    </div>
  </div>
  <div style="background:${C.dkgrn};border:1px solid ${C.green}44;border-radius:6px;padding:12px 20px;font-size:13px;color:${C.green};">
    <strong>PRO TIP:</strong> If you don't like the answer — say 'make it shorter,' 'more formal,' or 'try a different angle.' AI remembers the conversation.
  </div>
  <div style="font-size:11px;color:${C.muted};">Source: Upbound 90-Day AI Literacy Program, Week 6</div>
</div>`;
}

function pageBuild1() {
  const cards = [
    { color:C.blue, label:'WRITING AGENT', prompt:`"Every Monday morning, summarize my three biggest priorities for the week. Ask me for them on Sunday night. Format as a short bullet list I can paste into my team standup."` },
    { color:C.green, label:'DIGEST AGENT', prompt:`"You are my daily work assistant. Each morning, ask me: what meetings do I have, what is my #1 goal, and what's one thing I need to decide today. Then summarize it in 5 lines."` },
    { color:C.purple, label:'RESEARCH AGENT', prompt:`"When I share a competitor's website or product page, summarize it in 5 bullets: what they do, who they target, their key CTA, one thing they do well, one opportunity we have against them."` },
    { color:C.yellow, label:'STAKEHOLDER AGENT', prompt:`"I'm a Growth PM. When I paste my weekly KPIs, draft a 2-paragraph update for my VP. Lead with the win, call out one risk, end with a recommendation. Keep it under 150 words."` },
  ];
  return `
<div style="display:flex;flex-direction:column;gap:16px;height:100%;">
  <div>
    <div style="font-size:clamp(16px,2.2vw,26px);font-weight:800;color:${C.white};letter-spacing:.5px;">BUILD YOUR FIRST AGENT — RIGHT NOW</div>
    <div style="font-size:13px;color:${C.muted};margin-top:4px;">Open Claude Desktop. Copy any prompt below. You just built an agent.</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;flex:1;">
    ${cards.map(c=>`
    <div style="background:${C.card};border:1px solid ${c.color}33;border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:10px;">
      <span style="background:${c.color};color:#000;font-size:11px;font-weight:700;padding:3px 10px;border-radius:4px;align-self:flex-start;letter-spacing:1px;">${c.label}</span>
      <div style="background:#0a0f1e;border:1px solid ${c.color}22;border-radius:4px;padding:12px;font-family:Consolas,monospace;font-size:12px;color:${c.color};line-height:1.6;flex:1;">${c.prompt}</div>
    </div>`).join('')}
  </div>
  <div style="background:${C.dkgrn};border:1px solid ${C.green}44;border-radius:6px;padding:12px 20px;font-size:13px;color:${C.green};">
    <strong>TIP:</strong> After you paste the prompt, say 'Schedule this to run automatically every [day/week]' — that turns it into a recurring agent
  </div>
</div>`;
}

function pageBuild2() {
  return `
<div style="display:flex;align-items:center;justify-content:center;height:100%;">
  <div style="display:flex;gap:48px;align-items:center;max-width:900px;width:100%;">
    <div style="flex:1;display:flex;flex-direction:column;gap:20px;">
      <div style="background:${C.dkgrn};border:2px solid ${C.green};border-radius:10px;padding:28px 36px;text-align:center;">
        <div style="font-size:72px;font-weight:900;color:${C.green};letter-spacing:-2px;line-height:1;">LIVE DEMO</div>
      </div>
      <div style="font-size:22px;color:${C.white};font-weight:600;text-align:center;">Let's build something together</div>
      <div style="background:${C.card};border:1px solid ${C.green}44;border-radius:8px;padding:16px 20px;text-align:center;">
        <div style="font-size:14px;color:${C.white};">Building an agent that schedules itself to brief you every morning — automatically</div>
        <div style="font-size:12px;color:${C.muted};margin-top:8px;">No coding required &nbsp;|&nbsp; Runs on approved tools &nbsp;|&nbsp; You can replicate it in minutes</div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${[
        { label:'No code', color:C.green },
        { label:'Approved tools', color:C.blue },
        { label:'Replicable', color:C.yellow },
      ].map(b=>`
      <div style="border:2px solid ${b.color};border-radius:8px;padding:12px 24px;font-size:15px;font-weight:700;color:${b.color};text-align:center;min-width:160px;">${b.label}</div>`).join('')}
    </div>
  </div>
</div>`;
}

function pageBuild3() {
  return `
<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:32px;">
  <div style="text-align:center;">
    <div style="font-size:clamp(20px,2.5vw,32px);font-weight:800;color:${C.white};margin-bottom:8px;">SEE IT IN ACTION</div>
    <div style="font-size:16px;color:${C.muted};">Matt Allred — Legal AI Overview &nbsp;&bull;&nbsp; ~4 min</div>
  </div>
  <a href="/video/LegalAIOverview.mp4" target="_blank" rel="noopener"
     style="display:flex;flex-direction:column;align-items:center;gap:20px;background:${C.card};border:2px solid ${C.green};border-radius:16px;padding:48px 64px;cursor:pointer;text-decoration:none;transition:background .2s;"
     onmouseover="this.style.background='#1a2a0a'" onmouseout="this.style.background='${C.card}'">
    <div style="width:96px;height:96px;border-radius:50%;background:${C.green};display:flex;align-items:center;justify-content:center;">
      <div style="width:0;height:0;border-style:solid;border-width:20px 0 20px 36px;border-color:transparent transparent transparent #000;margin-left:8px;"></div>
    </div>
    <div style="font-size:22px;font-weight:700;color:${C.green};">Watch Video</div>
    <div style="font-size:14px;color:${C.muted};">Opens in a new window</div>
  </a>
</div>`;
}

function pageQA(localIP) {
  return `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:28px;height:100%;align-items:start;padding-top:8px;">
  <div style="display:flex;flex-direction:column;gap:16px;">
    <div>
      <div style="font-size:72px;font-weight:900;color:${C.white};line-height:1;">Q&amp;A</div>
      <div style="font-size:14px;color:${C.muted};font-style:italic;margin-top:6px;">No question too basic — that's why we're here</div>
    </div>
    <div style="background:${C.dkgrn};border:1px solid ${C.green}33;border-radius:8px;padding:18px 20px;display:flex;flex-direction:column;gap:10px;">
      <div style="font-size:12px;font-weight:700;color:${C.green};letter-spacing:2px;">YOUR TAKEAWAYS</div>
      ${[
        'Start small — pick one weekly task and try AI on it today',
        'Use Claude or Copilot — both approved and available now',
        'Remember: Role + Task + Context + Format',
        'No PII, no restricted data — when in doubt: AIGroup@upbound.com',
        'Mark AI-generated content as AI-generated in internal systems',
      ].map(t=>`<div style="display:flex;gap:10px;align-items:flex-start;"><span style="color:${C.green};font-size:14px;margin-top:1px;">&rarr;</span><span style="font-size:13px;color:${C.white};line-height:1.5;">${t}</span></div>`).join('')}
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:12px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:${C.green};">RESOURCES &amp; NEXT STEPS</div>
    ${[
      { color:C.green, title:'InfoSecurity Portal', detail:'raccorp.sharepoint.com/sites/InfoSecurity' },
      { color:C.blue, title:'AI Working Group', detail:'AIGroup@upbound.com' },
      { color:C.yellow, title:'Submit a New Tool or Idea', detail:'MS Form — link in AI Guidelines doc' },
      { color:C.purple, title:'90-Day AI Literacy Program', detail:'Live weekly sessions — ask your manager' },
      { color:C.teal, title:'AI Innovation Center', detail:'Internal sandbox — register via intranet' },
    ].map(r=>`
    <div style="background:${C.card};border:1px solid ${C.border};border-radius:6px;display:flex;overflow:hidden;">
      <div style="width:4px;background:${r.color};flex-shrink:0;"></div>
      <div style="padding:10px 14px;">
        <div style="font-size:14px;font-weight:600;color:${C.white};">${r.title}</div>
        <div style="font-size:12px;color:${C.muted};margin-top:2px;">${r.detail}</div>
      </div>
    </div>`).join('')}
  </div>
</div>`;
}

// ─── Page registry ────────────────────────────────────────────────────────────
const PAGES = {
  intro:   [pageIntro1, pageIntro2, pageIntro3],
  tools:   [pageTools1, pageTools2],
  rules:   [pageRules1],
  skills:  [pageSkills1, pageSkills2],
  build:   [pageBuild1, pageBuild3, pageBuild2],
  qa:      [pageQA],
  branch1: [(localIP) => pageBranch(1, localIP)],
  branch2: [(localIP) => pageBranch(2, localIP)],
};

function renderPage(sectionId, pageIndex, localIP) {
  const pages = PAGES[sectionId];
  if (!pages || pageIndex >= pages.length) return '<div>Page not found</div>';
  return pages[pageIndex](localIP);
}

function totalPages(sectionId) {
  return (PAGES[sectionId] || []).length;
}

// ─── HTML shells ──────────────────────────────────────────────────────────────
function presenterHTML(baseURL) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Lunch &amp; Learn — Presenter</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:${C.bg};color:${C.white};font-family:Calibri,system-ui,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden;}
#topbar{background:${C.footer};border-bottom:1px solid ${C.border};padding:10px 24px;display:flex;align-items:center;justify-content:space-between;min-height:48px;flex-shrink:0;}
#topbar .session{font-size:13px;font-weight:700;color:${C.green};letter-spacing:1px;}
#topbar .section{font-size:13px;color:${C.muted};text-transform:uppercase;letter-spacing:1px;}
#topbar .pager{font-size:13px;color:${C.muted};}
#content{flex:1;overflow:hidden;padding:24px 32px;border-left:8px solid ${C.green};position:relative;}
#content-inner{height:100%;animation:fadein .4s ease;zoom:1.75;}
@keyframes fadein{from{opacity:0;}to{opacity:1;}}
#bottombar{background:${C.footer};border-top:1px solid ${C.border};padding:10px 24px;display:flex;align-items:center;gap:12px;min-height:52px;flex-shrink:0;}
.btn{background:${C.card};border:1px solid ${C.border};color:${C.white};padding:8px 18px;border-radius:5px;cursor:pointer;font-size:13px;font-family:inherit;transition:background .15s;}
.btn:hover{background:#1e293b;}
.btn-green{border-color:${C.green};color:${C.green};}
.btn-red{border-color:${C.red};color:${C.red};}
.btn-yellow{border-color:${C.yellow};color:${C.yellow};}
#vote-panel{position:fixed;top:56px;right:16px;background:rgba(17,24,39,.95);border:1px solid ${C.border};border-radius:8px;padding:16px;min-width:220px;max-width:280px;z-index:100;backdrop-filter:blur(8px);}
#vote-panel h3{font-size:12px;letter-spacing:2px;color:${C.green};margin-bottom:12px;}
.vote-bar-row{margin-bottom:10px;}
.vote-bar-label{display:flex;justify-content:space-between;font-size:12px;color:${C.white};margin-bottom:4px;}
.vote-bar-track{background:${C.border};border-radius:3px;height:8px;overflow:hidden;}
.vote-bar-fill{height:100%;border-radius:3px;transition:width .3s ease;}
#winner-overlay{position:fixed;inset:0;background:rgba(10,15,30,.85);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(4px);}
#winner-overlay .winner-box{text-align:center;}
#winner-overlay .winner-label{font-size:18px;color:${C.muted};letter-spacing:3px;margin-bottom:12px;}
#winner-overlay .winner-name{font-size:clamp(32px,5vw,64px);font-weight:900;color:${C.green};}
</style>
</head><body>
<div id="topbar">
  <div class="session">AI LUNCH &amp; LEARN</div>
  <div class="section" id="section-label"></div>
  <div class="pager" id="pager"></div>
</div>
<div id="content">
  <div id="content-inner"></div>
</div>
<div id="bottombar">
  <button class="btn" onclick="go('/admin/prev')">&#8592; PREV</button>
  <button class="btn" onclick="go('/admin/next')">NEXT &#8594;</button>
  <button class="btn btn-green" id="vote-btn" onclick="toggleVote()">OPEN VOTE (V)</button>
  <button class="btn btn-yellow" onclick="go('/admin/reset')">RESET (R)</button>
</div>
<script>
const baseURL = ${JSON.stringify(baseURL)};
let currentState = null;
let voteOpen = false;

function go(path){fetch(path);}
function toggleVote(){
  if(!voteOpen) go('/admin/open-vote');
  else go('/admin/close-vote');
}

function sectionName(id){
  const m={intro:'Introduction',tools:'AI Toolkit',rules:'Know the Rules',skills:'Skills &amp; Prompting',build:'Build an Agent',qa:'Q&amp;A',branch1:'Choose Your Path',branch2:'Choose Your Path'};
  return m[id]||id;
}

let reconnectDelay=1000;
function connectPresenterSSE(){
  const es=new EventSource('/events');
  es.onmessage=function(e){
    reconnectDelay=1000;
    const d=JSON.parse(e.data);
    if(d.type==='state') applyState(d);
  };
  es.onerror=function(){
    es.close();
    setTimeout(connectPresenterSSE,reconnectDelay);
    reconnectDelay=Math.min(reconnectDelay*2,30000);
  };
}
connectPresenterSSE();

function applyState(d){
  currentState = d;
  voteOpen = d.votingOpen;
  document.getElementById('section-label').textContent = sectionName(d.section).replace(/&amp;/g,'&');
  const total = ${JSON.stringify(Object.fromEntries(Object.entries(PAGES).map(([k,v])=>[k,v.length])))};
  const t = total[d.section]||1;
  document.getElementById('pager').textContent = (d.pageIndex+1)+' / '+t;
  document.getElementById('vote-btn').textContent = d.votingOpen ? 'CLOSE VOTE (C)' : 'OPEN VOTE (V)';
  document.getElementById('vote-btn').className = 'btn ' + (d.votingOpen ? 'btn-red' : 'btn-green');

  // render page
  renderPage(d.section, d.pageIndex);

  // vote panel
  const panel = document.getElementById('vote-panel');
  if(panel) panel.remove();
  if(d.votingOpen && d.voteOptions && d.voteOptions.length){
    buildVotePanel(d);
  }

  // winner overlay
  const ov = document.getElementById('winner-overlay');
  if(ov) ov.remove();
  if(d.phase==='winner' && d.winnerSection){
    const opt = (d.voteOptions||[]).find(o=>o.id===d.winnerSection)||{label:d.winnerSection,color:'#84CC16'};
    buildWinnerOverlay(opt);
  }
}

async function renderPage(section, idx){
  const r = await fetch('/page?section='+section+'&idx='+idx);
  const html = await r.text();
  const inner = document.getElementById('content-inner');
  inner.style.animation='none';
  inner.offsetHeight;
  inner.style.animation='';
  // innerHTML doesn't execute scripts — strip and re-run them manually
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const scripts = tmp.querySelectorAll('script');
  scripts.forEach(s => s.remove());
  inner.innerHTML = tmp.innerHTML;
  scripts.forEach(s => {
    const el = document.createElement('script');
    el.textContent = s.textContent;
    inner.appendChild(el);
  });
}

function buildVotePanel(d){
  const total = Object.values(d.voteCounts).reduce((a,b)=>a+b,0)||1;
  const html = '<div id="vote-panel"><h3>LIVE VOTES</h3>' +
    d.voteOptions.map(o=>{
      const cnt = d.voteCounts[o.id]||0;
      const pct = Math.round(cnt/total*100);
      return '<div class="vote-bar-row">'
        +'<div class="vote-bar-label"><span>'+o.label+'</span><span>'+cnt+' ('+pct+'%)</span></div>'
        +'<div class="vote-bar-track"><div class="vote-bar-fill" style="width:'+pct+'%;background:'+o.color+';"></div></div>'
        +'</div>';
    }).join('')+'</div>';
  document.body.insertAdjacentHTML('beforeend',html);
}

function buildWinnerOverlay(opt){
  const html='<div id="winner-overlay"><div class="winner-box">'
    +'<div class="winner-label">WINNER</div>'
    +'<div class="winner-name" style="color:'+opt.color+';">'+opt.label+'</div>'
    +'</div></div>';
  document.body.insertAdjacentHTML('beforeend',html);
}

document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  const onVideo = !!document.getElementById('demo-video');
  if(e.key==='ArrowRight'){e.preventDefault();go('/admin/next');}
  else if(e.key===' '){
    e.preventDefault();
    if(onVideo){ const v=document.getElementById('demo-video'); v&&(v.paused?v.play():v.pause()); }
    else go('/admin/next');
  }
  else if(e.key==='ArrowLeft'){e.preventDefault();go('/admin/prev');}
  else if(e.key==='v'||e.key==='V'){go('/admin/open-vote');}
  else if(e.key==='c'||e.key==='C'){go('/admin/close-vote');}
  else if(e.key==='r'||e.key==='R'){if(confirm('Reset the session?'))go('/admin/reset');}
});

// init
fetch('/state').then(r=>r.json()).then(applyState);
</script>
</body></html>`;
}

function renderAudienceState(d) {
  const total = Object.values(d.voteCounts || {}).reduce((a, b) => a + b, 0) || 1;
  if (d.phase === 'winner' && d.winnerSection) {
    const opt = (d.voteOptions || []).find(o => o.id === d.winnerSection) || { label: d.winnerSection, color: C.green };
    return `<div class="winner-announce" style="color:${opt.color};">${opt.label}</div><div class="winner-sub">Loading that section now...</div>`;
  }
  if (!d.votingOpen) {
    const names = { intro:'Introduction', tools:'AI Toolkit', rules:'Know the Rules', skills:'Skills & Prompting', build:'Build an Agent', qa:'Q&A', branch1:'Choose Your Path', branch2:'Choose Your Path' };
    return `<div class="standby-section">${names[d.section] || d.section}</div><div class="standby-sub">Stand by — your presenter will open voting soon</div><div class="dot" style="margin-top:16px;"></div>`;
  }
  const buttons = (d.voteOptions || []).map(o =>
    `<button class="vote-btn" style="background:${o.color}22;color:${o.color};border:2px solid ${o.color}44;" onclick="castVote('${o.id}')">${o.label}</button>`
  ).join('');
  const bars = (d.voteOptions || []).map(o => {
    const cnt = (d.voteCounts || {})[o.id] || 0;
    const pct = Math.round(cnt / total * 100);
    return `<div class="bar-row"><div style="display:flex;justify-content:space-between;font-size:12px;color:#64748B;"><span>${o.label}</span><span>${cnt} (${pct}%)</span></div><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${o.color};"></div></div></div>`;
  }).join('');
  return `<div class="vote-q">What do you want to cover?</div><div style="display:flex;flex-direction:column;gap:10px;">${buttons}</div><div style="display:flex;flex-direction:column;gap:6px;">${bars}</div>`;
}

function audienceHTML(baseURL) {
  const initialHTML = renderAudienceState({
    phase: state.phase,
    votingOpen: state.votingOpen,
    section: state.currentSection,
    voteOptions: state.voteOptions,
    voteCounts: (() => { const c = {}; for (const o of state.voteOptions) c[o.id] = 0; for (const v of Object.values(state.votes)) if (c[v] !== undefined) c[v]++; return c; })(),
    winnerSection: state.winnerSection,
  });
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>AI Lunch &amp; Learn — Vote</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:${C.bg};color:${C.white};font-family:Calibri,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px;}
.container{width:100%;max-width:480px;display:flex;flex-direction:column;gap:20px;}
.standby-section{font-size:28px;font-weight:700;color:${C.white};text-align:center;}
.standby-sub{font-size:14px;color:${C.muted};text-align:center;line-height:1.6;}
.dot{width:12px;height:12px;border-radius:50%;background:${C.green};margin:0 auto;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.4;transform:scale(.85);}}
.vote-q{font-size:22px;font-weight:700;color:${C.white};text-align:center;line-height:1.3;}
.vote-btn{width:100%;min-height:80px;border-radius:8px;border:none;cursor:pointer;font-size:18px;font-weight:700;font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0 16px;transition:opacity .2s;letter-spacing:.5px;}
.vote-btn:active{opacity:.7;}
.vote-btn:disabled{opacity:.5;cursor:default;}
.confirm{font-size:20px;font-weight:700;text-align:center;padding:20px;}
.winner-announce{font-size:32px;font-weight:800;text-align:center;}
.winner-sub{font-size:14px;color:${C.muted};text-align:center;margin-top:8px;}
.bar-row{margin-top:6px;}
.bar-track{background:${C.border};border-radius:3px;height:6px;overflow:hidden;margin-top:4px;}
.bar-fill{height:100%;border-radius:3px;transition:width .3s;}
</style>
</head><body>
<div class="container" id="app">${initialHTML}</div>
<script>
let voted = false;
let myVote = null;
let lastPhase = null;
let lastSection = null;
let lastVotingOpen = null;
let lastRender = 0;

let rDelay=1000;
function connectSSE(){
  const es=new EventSource('/events');
  es.onmessage=function(e){
    rDelay=1000;
    try{const d=JSON.parse(e.data);if(d.type==='state')render(d);}catch(e){}
  };
  es.onerror=function(){
    es.close();
    setTimeout(connectSSE,rDelay);
    rDelay=Math.min(rDelay*2,30000);
  };
}
connectSSE();

// Polling fallback — kicks in if SSE hasn't delivered a render within 3s
function pollState(){
  if(Date.now()-lastRender>3000){
    fetch('/state').then(r=>r.json()).then(render).catch(()=>{});
  }
  setTimeout(pollState,3000);
}
setTimeout(pollState,3000);

function sectionName(id){
  const m={intro:'Introduction',tools:'AI Toolkit',rules:'Know the Rules',skills:'Skills &amp; Prompting',build:'Build an Agent',qa:'Q&amp;A',branch1:'Choose Your Path',branch2:'Choose Your Path'};
  return (m[id]||id).replace(/&amp;/g,'&');
}

function render(d){
  lastRender=Date.now();
  currentOptions = d.voteOptions || [];
  if(d.section!==lastSection){voted=false;myVote=null;}
  lastSection=d.section;
  lastVotingOpen=d.votingOpen;
  lastPhase=d.phase;

  const app=document.getElementById('app');
  const total=Object.values(d.voteCounts||{}).reduce((a,b)=>a+b,0)||1;

  if(d.phase==='winner'&&d.winnerSection){
    const opt=(d.voteOptions||[]).find(o=>o.id===d.winnerSection)||{label:d.winnerSection,color:'#84CC16'};
    app.innerHTML='<div class="winner-announce" style="color:'+opt.color+';">'+opt.label+'</div>'
      +'<div class="winner-sub">Loading that section now...</div>';
    return;
  }

  if(!d.votingOpen){
    app.innerHTML='<div class="standby-section">'+sectionName(d.section)+'</div>'
      +'<div class="standby-sub">Stand by — your presenter will open voting soon</div>'
      +'<div class="dot" style="margin-top:16px;"></div>';
    return;
  }

  if(voted&&myVote){
    const opt=(d.voteOptions||[]).find(o=>o.id===myVote)||{label:myVote,color:'#84CC16'};
    let bars='';
    for(const o of (d.voteOptions||[])){
      const cnt=d.voteCounts[o.id]||0;
      const pct=Math.round(cnt/total*100);
      bars+='<div class="bar-row"><div style="display:flex;justify-content:space-between;font-size:12px;color:#64748B;"><span>'+o.label+'</span><span>'+cnt+' ('+pct+'%)</span></div>'
        +'<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+o.color+';"></div></div></div>';
    }
    app.innerHTML='<div class="confirm" style="color:'+opt.color+';">Vote cast for '+opt.label+' &#10003;</div>'
      +'<div style="display:flex;flex-direction:column;gap:6px;">'+bars+'</div>';
    return;
  }

  // voting open, not yet voted
  const buttons=(d.voteOptions||[]).map(o=>
    '<button class="vote-btn" style="background:'+o.color+'22;color:'+o.color+';border:2px solid '+o.color+'44;" onclick="castVote(\''+o.id+'\')">'+o.label+'</button>'
  ).join('');

  // vote counts
  let bars='';
  for(const o of (d.voteOptions||[])){
    const cnt=d.voteCounts[o.id]||0;
    const pct=Math.round(cnt/total*100);
    bars+='<div class="bar-row"><div style="display:flex;justify-content:space-between;font-size:12px;color:#64748B;"><span>'+o.label+'</span><span>'+cnt+' ('+pct+'%)</span></div>'
      +'<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+o.color+';"></div></div></div>';
  }

  app.innerHTML='<div class="vote-q">What do you want to cover?</div>'
    +'<div style="display:flex;flex-direction:column;gap:10px;">'+buttons+'</div>'
    +'<div style="display:flex;flex-direction:column;gap:6px;">'+bars+'</div>';
}

// Persistent voter ID — survives refresh, avoids IP dedup issues
let voterId = '';
try { voterId = localStorage.getItem('vid') || ''; } catch(e){}
if (!voterId) {
  voterId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { localStorage.setItem('vid', voterId); } catch(e){}
}

let currentOptions = [];

function castVote(optId){
  if(voted) return;
  voted=true; myVote=optId;
  // Immediately update UI — don't wait for SSE
  const opt = currentOptions.find(o=>o.id===optId) || {label:optId.toUpperCase(), color:'#84CC16'};
  document.getElementById('app').innerHTML =
    '<div class="confirm" style="color:'+opt.color+';">Vote cast for '+opt.label+' &#10003;</div>';
  fetch('/vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({option:optId, voterId:voterId})}).catch(()=>{});
}

fetch('/state').then(r=>r.json()).then(render).catch(()=>{});
</script>
</body></html>`;
}

// ─── Request handler ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const localIP = getLocalIP();

function getBaseURL(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (host.match(/^localhost/) ? 'http' : 'https');
  return `${proto}://${host}`;
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const path = parsed.pathname;

  // Image files
  if (path.startsWith('/img/')) {
    const filename = nodePath.basename(path);
    if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(filename)) { res.writeHead(403); res.end(); return; }
    const filepath = nodePath.join(__dirname, filename);
    if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext = nodePath.extname(filename).toLowerCase();
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(filepath).pipe(res);
    return;
  }

  // Video file streaming (supports range requests for scrubbing)
  if (path.startsWith('/video/')) {
    const filename = nodePath.basename(path);
    const filepath = nodePath.join(__dirname, filename);
    if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return; }
    const stat = fs.statSync(filepath);
    const ext = nodePath.extname(filename).toLowerCase();
    const mime = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'video/quicktime';
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024, stat.size - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      });
      fs.createReadStream(filepath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filepath).pipe(res);
    }
    return;
  }

  // SSE
  if (path === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':\n\n'); // keep-alive comment
    clients.add(res);
    req.on('close', () => clients.delete(res));
    broadcastState(); // send current state to new subscriber
    return;
  }

  // State JSON
  if (path === '/state') {
    const voteCounts = {};
    for (const opt of state.voteOptions) voteCounts[opt.id] = 0;
    for (const v of Object.values(state.votes)) {
      if (voteCounts[v] !== undefined) voteCounts[v]++;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'state',
      phase: state.phase,
      section: state.currentSection,
      pageIndex: state.currentPageIndex,
      votingOpen: state.votingOpen,
      voteOptions: state.voteOptions,
      voteCounts,
      winnerSection: state.winnerSection,
    }));
    return;
  }

  // Page fragment
  if (path === '/page') {
    const section = parsed.searchParams.get('section') || 'intro';
    const idx = parseInt(parsed.searchParams.get('idx') || '0', 10);
    const baseURL = getBaseURL(req);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPage(section, idx, baseURL));
    return;
  }

  // Presenter
  if (path === '/') {
    const baseURL = getBaseURL(req);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(presenterHTML(baseURL));
    return;
  }

  // Audience
  if (path === '/vote' && req.method === 'GET') {
    const baseURL = getBaseURL(req);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(audienceHTML(baseURL));
    return;
  }

  // Vote POST
  if (path === '/vote' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      if (!state.votingOpen) { res.writeHead(403); res.end(); return; }
      try {
        const { option, voterId } = JSON.parse(body);
        const key = voterId || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        if (!state.votes[key] && state.voteOptions.find(o => o.id === option)) {
          state.votes[key] = option;
          broadcastState();
        }
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    return;
  }

  // Admin controls
  if (path === '/admin/next') {
    advanceNext();
    res.writeHead(200); res.end(); return;
  }
  if (path === '/admin/prev') {
    advancePrev();
    res.writeHead(200); res.end(); return;
  }
  if (path === '/admin/open-vote') {
    openVote();
    res.writeHead(200); res.end(); return;
  }
  if (path === '/admin/close-vote') {
    closeVote();
    res.writeHead(200); res.end(); return;
  }
  if (path === '/admin/reset') {
    resetState();
    broadcastState();
    res.writeHead(200); res.end(); return;
  }
  if (path === '/admin/goto') {
    const section = parsed.searchParams.get('section');
    if (section) { goToSection(section); broadcastState(); }
    res.writeHead(200); res.end(); return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  AI Lunch & Learn — Choose Your Own Adventure');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Presenter: http://localhost:${PORT}`);
  console.log(`  Audience:  http://${localIP}:${PORT}/vote`);
  console.log('  ─────────────────────────────────────────────');
  console.log('  Controls:  -> next  <- prev  V vote  C close  R reset');
  console.log('');
});
